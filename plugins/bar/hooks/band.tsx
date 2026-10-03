import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { BarData, Fill, Limit, BarSettings, Tokens, Turn } from '../types'
import { cacheExpiry } from './cache'
import { clockTime, colorFor, countdown, duration, longDate, resetTime, shortCount, until } from './format'
import { DEFAULTS, parseJsonc, SETTINGS_FILE, TEMPLATE, toSettings, withLimit } from './settings'
import { liveSnapshot } from './turns'

// Whether a tree drawn beneath this hook shows anything: the engine's own
// answer for the band is an empty Box.
const hasContent = (element: unknown) => {
  const tree = element as { type?: string; children?: unknown[] } | null | undefined

  return Boolean(tree) && !(tree?.type === 'Box' && (tree.children ?? []).length === 0)
}

// The smallest limit /bar-limit takes; the largest is the model's window.
const MIN_LIMIT = 10_000
// How often the settings file is checked for changes.
const SETTINGS_POLL_MS = 3_000
const CONTEXT_CELLS = 18
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 24 * 3_600_000,
}
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly limit',
}

const fill = atom({ plugin: 'bar', key: 'fill' } as const, null)
const limits = atom({ plugin: 'bar', key: 'limits' } as const, [])
// The turns (written by the turn hooks): the bar shows the running turn's
// time and tokens while Claude works.
const turnList = atom({ plugin: 'bar', key: 'turns' } as const, [])
const settingsAtom = atom({ plugin: 'bar', key: 'settings' } as const, null)
const cacheAtom = atom({ plugin: 'bar', key: 'cache' } as const, null)
const handoffAtom = atom({
  plugin: 'bar',
  key: 'handoff',
} as const, { status: 'idle', path: null, clickedAt: null, turnId: null, detail: null })
// All as wide as the widest, so the pill keeps its width as they change.
const HANDOFF_LABELS = {
  idle: 'Hand off',
  requested: 'Writing…',
  writing: 'Writing…',
  opening: 'Opening…',
  opened: 'Opened ✓',
  error: 'Failed',
} as const
const HANDOFF_CELLS = Math.max(...Object.values(HANDOFF_LABELS).map(label => label.length))
// The countdown never needs more than `60:00`.
const COUNTDOWN_CELLS = 5
// Which sample /bar-demo shows in place of the live bar; -1 is the live bar.
// Starts on the fullest sample, the one with every element in it.
const DEMO_START = 2
const demo = atom({ plugin: 'bar', key: 'demo' } as const, DEMO_START)

// The session may still hold the earlier on/off value; read it as the start.
const demoIndex = (value: unknown) => (typeof value === 'number' ? value : DEMO_START)

const HOUR = 3_600_000

// Sample states for /bar-demo, from a fresh session to one past its limits.
const samples = (now: number): { label: string; data: BarData }[] => [
  {
    label: 'API key (no plan limits), fresh session',
    data: { tokens: 12_400, limit: 400_000, limits: [] },
  },
  {
    label: 'Light use',
    data: {
      tokens: 148_000,
      limit: 400_000,
      limits: [
        { kind: 'five_hour', percent: 18, resetsAt: new Date(now + 3 * HOUR).toISOString() },
        { kind: 'seven_day', percent: 34, resetsAt: new Date(now + 80 * HOUR).toISOString() },
      ],
    },
  },
  {
    label: 'Getting full',
    data: {
      tokens: 286_000,
      limit: 400_000,
      limits: [
        { kind: 'five_hour', percent: 62, resetsAt: new Date(now + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percent: 71, resetsAt: new Date(now + 50 * HOUR).toISOString() },
      ],
    },
  },
  {
    label: 'Past the limit, plan nearly used',
    data: {
      tokens: 431_000,
      limit: 400_000,
      limits: [
        { kind: 'five_hour', percent: 96, resetsAt: new Date(now + 0.4 * HOUR).toISOString() },
        { kind: 'seven_day', percent: 88, resetsAt: new Date(now + 20 * HOUR).toISOString() },
      ],
    },
  },
]

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }

// The pill borders' colours, one per level the meters use.
const TINTS: Record<string, string> = {
  success: 'rgba(34, 160, 90, 0.28)',
  warning: 'rgba(202, 138, 4, 0.30)',
  claude: 'rgba(217, 119, 87, 0.32)',
  error: 'rgba(220, 38, 38, 0.30)',
}

// A thin line meter: the used part in the level's colour, the rest a dim track.
const line = (ratio: number, cells: number) => {
  const used = Math.min(cells, Math.round(Math.min(Math.max(ratio, 0), 1) * cells))

  return { used: '━'.repeat(used), rest: '━'.repeat(cells - used) }
}

// `300k`, `1.5m`, `250000`: a token count as a person types one.
const parseCount = (text: string) => {
  const match = /^([\d.]+)\s*([km]?)$/i.exec(text.trim().replaceAll(',', ''))

  if (!match) {
    return null
  }

  const [, amount = '', unit = ''] = match
  const scale = { '': 1, k: 1_000, m: 1_000_000 }[unit.toLowerCase() as '' | 'k' | 'm']
  const value = Math.round(Number(amount) * scale)

  return Number.isFinite(value) && value > 0 ? value : null
}

const toFill = (context: SessionContextUsage): Fill | null =>
  context.tokens === undefined
    ? null
    : { tokens: context.tokens, window: context.window }

const toLimits = (windows: SessionRateLimit[]): Limit[] =>
  windows
    .filter(window => window.kind in LIMIT_LABELS)
    .map(window => ({
      kind: window.kind,
      percent: window.percentUsed,
      resetsAt: window.resetsAt ?? null,
    }))

// The settings file's path, and its last-read modification time, so a check
// reads it again only when it changed.
let settingsPath: string | null = null
let settingsMtime = -1

// Reads ~/.claude/bar/settings.jsonc into the shared `settings` value,
// writing it with every default and its comments when it is missing. A file
// that does not parse keeps the last good settings and says why, once per
// change.
async function loadSettings($: EngineInterface) {
  if (!settingsPath) {
    const home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout
    settingsPath = `${home}/${SETTINGS_FILE}`
  }

  if (!(await $.fs.exists(settingsPath))) {
    await $.fs.write(settingsPath, TEMPLATE)
  }

  const { mtimeMs } = await $.fs.stat(settingsPath)

  if (mtimeMs === settingsMtime) {
    return
  }

  settingsMtime = mtimeMs

  try {
    const next = toSettings(parseJsonc(await $.fs.read(settingsPath)))
    await update($, settingsAtom, () => next)
  } catch (error) {
    $.ui.toast(
      `Bar settings: ${error instanceof Error ? error.message : 'the file has an error'}; keeping the last good settings`,
    )
  }
}

export const registerBand: Register = on => {
  on('session.start', async ($, e, next) => {
    // Each load starts on the live bar; /bar-demo brings the samples back.
    await update($, demo, () => -1)
    // Panels earlier versions opened and this one no longer draws.
    await $.ui.close({ id: 'bar-context' })
    await $.ui.close({ id: 'bar-file' })
    await $.ui.close({ id: 'bar-changes' })
    await $.ui.close({ id: 'bar-agents' })
    await $.command.register({
      name: 'bar-limit',
      description: "Set where the context meter turns red, e.g. /bar-limit 300k (off: the model's window)",
    })
    await $.command.register({
      name: 'bar-demo',
      description: 'Step through sample bars, then back to the live one',
    })

    await loadSettings($)
    $.clock.every(SETTINGS_POLL_MS, () => void loadSettings($))

    const usage = await $.session.usage()
    await update($, fill, () => toFill(usage.context))
    await update($, limits, () => toLimits(usage.rateLimits))

    return next(e)
  })

  on('command.run', { command: 'bar-limit' }, async ($, e) => {
    const settings = (await read($, settingsAtom)) ?? DEFAULTS
    const window = (await read($, fill))?.window ?? null
    const word = e.args.trim().toLowerCase()
    const current = settings.context.limit

    if (!word) {
      return {
        text:
          current === null
            ? `The context meter fills at the model's window${window ? ` (${shortCount(window)})` : ''}. Change it with /bar-limit 300k.`
            : `The context meter fills at ${shortCount(current)} tokens. /bar-limit off goes back to the model's window.`,
      }
    }

    // "off" (or "default", "model", "none") goes back to the model's window.
    const isOff = ['off', 'default', 'model', 'none'].includes(word)
    const wanted = isOff ? null : parseCount(word)

    if (!isOff && wanted === null) {
      return { text: 'Give a token count such as 300k, 1.5m or 250000, or "off" for the model\'s window.' }
    }

    const limit = wanted === null ? null : Math.max(MIN_LIMIT, window ? Math.min(wanted, window) : wanted)
    const text = settingsPath && (await $.fs.exists(settingsPath)) ? await $.fs.read(settingsPath) : TEMPLATE
    const updated = withLimit(text, limit)

    if (!updated || !settingsPath) {
      return { text: `Couldn't find "limit" in ${SETTINGS_FILE}; set it there by hand.` }
    }

    await $.fs.write(settingsPath, updated)
    await loadSettings($)

    return {
      text:
        limit === null
          ? "The context meter now fills at the model's window."
          : `The context meter now fills at ${shortCount(limit)} tokens${wanted !== null && limit < wanted ? ` (capped at the model's ${shortCount(limit)} window)` : ''}.`,
    }
  })

  on('command.run', { command: 'bar-demo' }, async $ => {
    const count = samples(0).length
    const shown = demoIndex(await read($, demo))
    // Past the last sample comes the live bar, then the first sample again.
    const nextIndex = shown + 1 >= count ? -1 : shown + 1
    await update($, demo, () => nextIndex)

    return {
      text:
        nextIndex === -1
          ? 'Showing the live bar.'
          : `Sample ${nextIndex + 1} of ${count}: ${samples(0)[nextIndex]?.label}. /bar-demo again for the next.`,
    }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context')) {
      await update($, fill, () => toFill(e.context))
    }
    if (e.changed.includes('rateLimits')) {
      await update($, limits, () => toLimits(e.rateLimits))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s: BarSettings = (await read($, settingsAtom)) ?? DEFAULTS

    if (e.props.hasSurvey || !s.bar.enabled) {
      return next(e)
    }

    // What other mods draw here (cards, notices) stays, above the bar.
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const level = (ratio: number) => colorFor(ratio, s.levels)
    const current = await read($, fill)
    const allTurns = await read($, turnList)
    const running = allTurns.findLast(turn => turn.endedAt === null)
    const lastDone = running ? undefined : allTurns.findLast(turn => turn.endedAt !== null)
    // While a turn runs the turn hooks ask for a redraw each second; the time
    // and tally are read here, at drawing, so they are current whenever it lands.
    const elapsed = running ? (await $.clock.now()) - running.startedAt : 0
    const liveTurn = running ? liveSnapshot() : null
    const now = await $.clock.now()
    const window = current?.window ?? null
    const cache = s.cache.enabled ? await read($, cacheAtom) : null
    const handoff = await read($, handoffAtom)

    const live: BarData = {
      tokens: current?.tokens ?? 0,
      // The model's window unless the person set a limit, never past it.
      limit: s.context.limit === null ? (window ?? 200_000) : Math.min(s.context.limit, window ?? s.context.limit),
      limits: await read($, limits),
    }

    // Line 1 is usage, each figure in a pill; line 2 is the turn (live while
    // Claude works, else the last one). Hovering a pill shows its detail in
    // line 2's place, which is why line 2 stays while it is on. A terminal
    // draws a border as three rows, so there the pills go borderless.
    const isFramed = e.surface !== 'terminal'
    const hasBorders = isFramed && s.bar.pillBorders
    const hasHover = s.bar.hover
    const hasDetails = hasHover && s.planLimits.hoverDetails && s.turn.enabled

    // A pill's detail, laid over line 2 while the pill is hovered: the same
    // single row, on a solid background, so nothing moves or resizes. (The
    // band clips anything drawn outside it, and growing it makes it jump.)
    const overlay = (scope: string, content: ReturnType<typeof Text>) => (
      <Box
        key={`${scope}-detail`}
        position="absolute"
        top={0}
        left={0}
        right={0}
        height={1}
        overflow="hidden"
        display="none"
        hover={{ scope, display: 'flex' }}
        backgroundColor="userMessageBackground"
        paddingX={isFramed ? 1 : 0}
      >
        {content}
      </Box>
    )

    // A pill's border carries its figure's level colour (green, yellow,
    // orange, red) at about a third strength: mid-tone colours, mostly
    // transparent, so the same values read as a light tint on a light and a
    // dark background alike. (Dimming a theme colour had no visible effect
    // on the desktop.)
    const border = (ratio: number) => TINTS[level(ratio)] ?? TINTS.success ?? 'inactive'

    const pill = (
      scope: string,
      grow: boolean,
      content: ReturnType<typeof Text> | ReturnType<typeof Box>,
      borderColor: string,
    ) => (
      <Box
        key={scope}
        flexGrow={grow ? 1 : 0}
        flexShrink={grow ? 1 : 0}
        // A growing pill gives up its room to the fixed ones, down to nothing,
        // instead of pushing the row past the edge.
        {...(grow ? { minWidth: 0, overflow: 'hidden' as const } : {})}
        paddingX={hasBorders ? 1 : 0}
        {...(hasBorders ? { borderStyle: 'round', borderColor } : {})}
        {...(hasHover ? { hover: hasBorders ? { scope, borderColor: 'suggestion' } : { scope } } : {})}
      >
        {content}
      </Box>
    )

    const link = (key: string, label: string, onPress: () => unknown) => (
      <Button
        key={key}
        label={label}
        plain
        {...(hasHover ? { hover: { scope: `bar-link-${key}`, underline: true } } : {})}
        onPress={onPress}
      />
    )

    const windowDetail = (window: Limit) => {
      const span = WINDOW_MS[window.kind] ?? 0
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null
      const share = resetsAt && span ? (now - (resetsAt - span)) / span : 0
      // Where usage lands at reset if it keeps the pace it has had so far;
      // too early in the window to say anything useful before a tenth of it.
      const pace = s.planLimits.pace && share >= 0.1 ? Math.round(window.percent / share) : null
      const tint = level(window.percent / 100)

      return overlay(
        `bar-${window.kind}`,
        <Text wrap="truncate-end">
          <Text bold>{WINDOW_NAMES[window.kind]}</Text>
          <Text color={tint} dimColor>
            {'  ·  '}
          </Text>
          <Text color={tint}>{Math.round(window.percent)}% used</Text>
          {resetsAt && (
            <Text>
              <Text color={tint} dimColor>
                {'  ·  resets '}
              </Text>
              {longDate(resetsAt)}
              <Text color={tint} dimColor>
                {' '}(in {until(resetsAt - now)})
              </Text>
            </Text>
          )}
          {pace !== null && (
            <Text color={pace >= 100 ? 'error' : tint} dimColor={pace < 100}>
              {'  ·  '}
              {pace >= 100 ? 'on pace to run out first' : `on pace for ~${pace}%`}
            </Text>
          )}
        </Text>,
      )
    }

    // A count in the normal text colour beside its label in a faint blue,
    // the accent the turn's duration is drawn in.
    const figure = (key: string, value: string, label: string, first = false) => (
      <Text key={key}>
        {!first && <Text color="suggestion" dimColor>{'  ·  '}</Text>}
        <Text>{value}</Text>
        <Text color="suggestion" dimColor>
          {' '}
          {label}
        </Text>
      </Text>
    )

    const tokenFigures = (tokens: Tokens, streaming = 0) =>
      s.turn.tokens
        ? [
            figure('in', shortCount(tokens.input), 'in'),
            figure('out', `${shortCount(tokens.output + streaming)}${streaming > 0 ? '+' : ''}`, 'out'),
            figure('read', shortCount(tokens.cacheRead), 'cache read'),
            figure('write', shortCount(tokens.cacheWrite), 'cache write'),
          ]
        : null

    const toolFigure = (tools: number) => {
      if (!s.turn.toolCalls) {
        return null
      }

      const label = `${tools} ${tools === 1 ? 'tool call' : 'tool calls'}`

      return (
        <Box key="tools-slot" flexGrow={1} flexShrink={0} justifyContent="flex-end" paddingLeft={3}>
          {s.turn.toolCallsPanel
            ? link('tools', label, () => $.ui.open({ id: 'bar-tools', title: 'Tool calls', focus: true }))
            : figure('tools', String(tools), tools === 1 ? 'tool call' : 'tool calls', true)}
        </Box>
      )
    }

    // The turn at the left of line 2, where it stays in view as replies
    // scroll: live while Claude works, else the last finished one.
    const turnLine = () => {
      if (running && s.turn.whileWorking) {
        return [
          <Box key="turn" flexShrink={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color="claude">● </Text>
              <Text>Working </Text>
              <Text color="suggestion" bold>
                {duration(elapsed)}
              </Text>
              {liveTurn && tokenFigures(liveTurn.tokens, liveTurn.streaming)}
            </Text>
          </Box>,
          toolFigure(liveTurn?.tools ?? 0),
        ]
      }

      if (!running && lastDone?.endedAt && s.turn.lastTurn) {
        const last: Turn = lastDone

        return [
          <Box key="turn" flexShrink={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text color="suggestion" dimColor>
                Last turn{' '}
              </Text>
              <Text color="suggestion">{duration((last.endedAt ?? 0) - last.startedAt)}</Text>
              {last.tokens && tokenFigures(last.tokens)}
            </Text>
          </Box>,
          // Turns from before tool calls were counted carry no figure.
          typeof last.tools === 'number' ? toolFigure(last.tools) : null,
        ]
      }

      return null
    }

    // The prompt cache: time left before the conversation drops out of it,
    // counted from the last response, and the Hand off button beside it.
    const expiry = cacheExpiry(cache)
    const cacheSpan = cache ? expiry! - cache.at : 1
    const cacheLeft = expiry === null ? 0 : expiry - now
    const cacheRatio = 1 - Math.max(cacheLeft, 0) / cacheSpan
    const cacheTint = cacheLeft > 0 ? level(cacheRatio) : 'error'

    const cachePill = () =>
      cache &&
      pill(
        'bar-cache',
        false,
        <Box flexDirection="row">
          <Text>Cache  </Text>
          {/* Fixed widths: the digits change every second, and the app's font gives them different widths. */}
          <Box width={Math.max(COUNTDOWN_CELLS, 'expired'.length)}>
            <Text color={cacheTint}>{cacheLeft > 0 ? countdown(cacheLeft) : 'expired'}</Text>
          </Box>
          {s.cache.handoff && (
            <Box flexDirection="row">
              <Text color={cacheTint} dimColor>
                {'  ·  '}
              </Text>
              <Box width={HANDOFF_CELLS}>
                {link(
                  'handoff',
                  HANDOFF_LABELS[handoff.status],
                  // The cache hooks start it on their next tick.
                  () =>
                    update($, handoffAtom, state =>
                      state.status === 'idle' || state.status === 'error' || state.status === 'opened'
                        ? { ...state, status: 'requested' as const }
                        : state,
                    ),
                )}
              </Box>
            </Box>
          )}
        </Box>,
        border(cacheLeft > 0 ? cacheRatio : 1),
      )

    const cacheDetail = () =>
      cache &&
      expiry !== null &&
      overlay(
        'bar-cache',
        <Text wrap="truncate-end">
          <Text bold>Prompt cache</Text>
          <Text color={cacheTint} dimColor>
            {'  ·  '}
            {cache.ttl === '1h' ? '1 hour' : '5 minutes'} from the last response{'  ·  '}
          </Text>
          {handoff.status === 'error' ? (
            <Text color="error">Hand off failed: {handoff.detail}</Text>
          ) : handoff.status === 'writing' ? (
            <Text>Writing the handoff, then opening a new session with it</Text>
          ) : (
            <Text>
              <Text color={cacheTint}>
                {cacheLeft > 0 ? `expires at ${clockTime(expiry, false)}` : `expired at ${clockTime(expiry, false)}`}
              </Text>
              {current && (
                <Text color={cacheTint} dimColor>
                  {'  ·  '}
                  {cacheLeft > 0 ? 'then' : 'so'} the next message writes {shortCount(current.tokens)} tokens again
                </Text>
              )}
            </Text>
          )}
        </Text>,
      )

    const bar = (data: BarData) => {
      const ratio = data.tokens / data.limit
      const context = line(ratio, CONTEXT_CELLS)
      const windows = data.limits.filter(window =>
        window.kind === 'five_hour' ? s.planLimits.fiveHour : s.planLimits.weekly,
      )
      const contextLabel =
        s.context.click === 'usage' ? (
          link('context', 'Context', () => $.command.run({ command: 'usage', args: '' }))
        ) : (
          <Text key="context-label">Context</Text>
        )
      const hasLine1 = s.context.enabled || windows.length > 0 || cache !== null

      return (
        <Box flexDirection="column">
          {hasLine1 && (
            <Box flexDirection="row" columnGap={1}>
              {s.context.enabled &&
                pill(
                  'bar-context',
                  true,
                  <Box flexDirection="row">
                    {contextLabel}
                    <Box flexShrink={1} height={1} overflow="hidden">
                      <Text wrap="truncate-end">
                        <Text>{'  '}</Text>
                        <Text color={level(ratio)}>{context.used}</Text>
                        <Text color={level(ratio)} dimColor>
                          {context.rest}
                        </Text>
                        <Text color={level(ratio)} bold>
                          {'  '}
                          {shortCount(data.tokens)}
                        </Text>
                        <Text color={level(ratio)} dimColor>
                          {' '}/ {shortCount(data.limit)}
                        </Text>
                      </Text>
                    </Box>
                  </Box>,
                  border(ratio),
                )}
              {windows.map(window =>
                pill(
                  `bar-${window.kind}`,
                  false,
                  <Text>
                    <Text>{LIMIT_LABELS[window.kind]}  </Text>
                    <Text color={level(window.percent / 100)}>{Math.round(window.percent)}%</Text>
                    {s.planLimits.resetTime && window.resetsAt && (
                      <Text color={level(window.percent / 100)} dimColor>
                        {' '}· {resetTime(window.resetsAt, now)}
                      </Text>
                    )}
                  </Text>,
                  border(window.percent / 100),
                ),
              )}
              {cachePill()}
            </Box>
          )}
          {s.turn.enabled && (
            <Box flexDirection="row" paddingX={isFramed ? 1 : 0} height={1} overflow="hidden">
              {turnLine()}
              {/* Last, so they paint over line 2 when shown. */}
              {hasDetails && windows.map(window => windowDetail(window))}
              {hasHover && s.turn.enabled && cacheDetail()}
            </Box>
          )}
        </Box>
      )
    }

    const sample = samples(now)[demoIndex(await read($, demo))]
    const own = bar(sample ? sample.data : live)

    return hasContent(below) ? (
      <Box flexDirection="column" rowGap={1}>
        {below}
        {own}
      </Box>
    ) : (
      own
    )
  })
}
