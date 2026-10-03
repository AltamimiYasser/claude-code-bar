import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  RenderChildren,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { BarData, BarSettings, CompactWindow, ContextLimit, Fill, Limit, Tokens, Turn } from '../types'
import { cacheExpiry } from './cache'
import { clockTime, colorFor, countdown, duration, longDate, resetTime, shortCount, until } from './format'
import { hruleSvg, meterSvg, pulseSvg, restingSvg, ruleSvg, sparkSvg } from './meter'
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
// How often the auto-compact window is read again between responses, so an
// edit to Claude Code's settings shows while idle.
const COMPACT_POLL_MS = 60_000
// In the terminal the context meter is two runs of the line glyph sharing
// whatever room the pill has left, in proportion: this many steps, each run
// long enough to fill the widest band, and cut at its box's edge.
const METER_STEPS = 1_000
const METER_GLYPHS = 400
// The desktop's meters, in CSS pixels: tall enough for the bead's glow.
const METER_HEIGHT = 14
const WINDOW_METER_WIDTH = 52
const SPARK_WIDTH = 72
// The terminal's window meters, in cells.
const WINDOW_METER_CELLS = 6
// The running turn's time never needs more than `59m 59s`.
const TIMER_CELLS = 7
// The terminal's `[-]` at the band's top right, and a space before it.
const COLLAPSE_CELLS = 4
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 24 * 3_600_000,
}
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly limit',
}

const fill = atom({ plugin: 'bar', key: 'fill' } as const, null)
const compactAtom = atom({ plugin: 'bar', key: 'compactWindow' } as const, null)
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
// What the Hand off button says as the handoff goes along.
const HANDOFF_LABELS = {
  idle: 'Hand off →',
  requested: 'Writing…',
  writing: 'Writing…',
  opening: 'Opening…',
  opened: 'Opened ✓',
  error: 'Failed',
} as const
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

// The panel's outline: a mid grey, faint, which reads on a light and a dark
// background alike.
const PANEL_BORDER = 'rgba(128, 128, 128, 0.32)'

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

// Before the first response there are no tokens yet, but the window is known.
const toFill = (context: SessionContextUsage): Fill => ({ tokens: context.tokens ?? 0, window: context.window })

// The window auto-compact measures against, from the context breakdown
// (estimated locally; no request is sent). Null where the session has none.
async function readCompactWindow($: EngineInterface): Promise<CompactWindow | null> {
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context

    return breakdown && breakdown.rawMaxTokens > 0
      ? { tokens: breakdown.rawMaxTokens, source: breakdown.autocompactSource }
      : null
  } catch {
    return null
  }
}

const refreshCompactWindow = async ($: EngineInterface) => {
  const next = await readCompactWindow($)
  if (next) {
    await update($, compactAtom, previous =>
      previous?.tokens === next.tokens && previous.source === next.source ? previous : next,
    )
  }
}

// The token count where the context meter is full: the auto-compact window
// (else the model's), the model's own window, or the person's number. Never
// past the model's window.
export const contextLimit = (setting: ContextLimit, window: number | null, compact: CompactWindow | null) => {
  const model = window ?? compact?.tokens ?? 200_000
  const wanted = setting === 'model' ? model : setting === 'autoCompact' ? (compact?.tokens ?? model) : setting

  return Math.min(wanted, model)
}

// What the limit is, in words, for the hover detail and /bar-limit.
const limitWords = (setting: ContextLimit, compact: CompactWindow | null) =>
  setting === 'model'
    ? "the model's full window"
    : setting === 'autoCompact'
      ? compact && compact.source !== 'auto'
        ? 'your auto-compact window'
        : "the model's full window (no auto-compact window set)"
      : 'your limit, set with /bar-limit'

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
      description: 'Set where the context meter turns red: /bar-limit 300k, model, or off (your auto-compact window)',
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
    await refreshCompactWindow($)
    $.clock.every(COMPACT_POLL_MS, () => void refreshCompactWindow($))

    return next(e)
  })

  on('command.run', { command: 'bar-limit' }, async ($, e) => {
    const settings = (await read($, settingsAtom)) ?? DEFAULTS
    const window = (await read($, fill))?.window ?? null
    await refreshCompactWindow($)
    const compact = await read($, compactAtom)
    const word = e.args.trim().toLowerCase()
    const describe = (setting: ContextLimit) =>
      `${shortCount(contextLimit(setting, window, compact))} tokens, ${limitWords(setting, compact)}`

    if (!word) {
      return {
        text: `The context meter fills at ${describe(settings.context.limit)}. Change it with /bar-limit 300k, /bar-limit model, or /bar-limit off for your auto-compact window.`,
      }
    }

    // "off" (or "default", "compact", "auto", "none") follows the auto-compact window.
    const isAuto = ['off', 'default', 'compact', 'autocompact', 'auto', 'none'].includes(word)
    const isModel = ['model', 'window', 'full'].includes(word)
    const wanted = isAuto || isModel ? null : parseCount(word)

    if (!isAuto && !isModel && wanted === null) {
      return {
        text: 'Give a token count such as 300k, 1.5m or 250000, "model" for the model\'s window, or "off" for your auto-compact window.',
      }
    }

    const limit: ContextLimit = isAuto
      ? 'autoCompact'
      : isModel
        ? 'model'
        : Math.max(MIN_LIMIT, window ? Math.min(wanted ?? 0, window) : (wanted ?? 0))
    const text = settingsPath && (await $.fs.exists(settingsPath)) ? await $.fs.read(settingsPath) : TEMPLATE
    const updated = withLimit(text, limit)

    if (!updated || !settingsPath) {
      return { text: `Couldn't find "limit" in ${SETTINGS_FILE}; set it there by hand.` }
    }

    await $.fs.write(settingsPath, updated)
    await loadSettings($)

    return {
      text: `The context meter now fills at ${describe(limit)}${typeof limit === 'number' && wanted !== null && limit < wanted ? ` (capped at the model's window)` : ''}.`,
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
      const before = (await read($, fill))?.window
      await update($, fill, () => toFill(e.context))
      // A model switch moves the auto-compact window too.
      if (before !== e.context.window) {
        await refreshCompactWindow($)
      }
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
    // The app surfaces draw SVG; the terminal has none and draws text instead.
    const Svg = e.surface === 'terminal' ? null : $.ui.resolve(e).Svg
    const level = (ratio: number) => colorFor(ratio, s.levels)
    const current = await read($, fill)
    const allTurns = await read($, turnList)
    const running = allTurns.findLast(turn => turn.endedAt === null)
    const lastDone = running ? undefined : allTurns.findLast(turn => turn.endedAt !== null)
    // While a turn runs the turn hooks ask for a redraw each second; the time
    // and tally are read here, at drawing, so they are current whenever it lands.
    const now = await $.clock.now()
    const elapsed = running ? now - running.startedAt : 0
    const liveTurn = running ? liveSnapshot() : null
    const window = current?.window ?? null
    const compact = await read($, compactAtom)
    const cache = s.cache.enabled ? await read($, cacheAtom) : null
    const handoff = await read($, handoffAtom)

    const live: BarData = {
      tokens: current?.tokens ?? 0,
      limit: contextLimit(s.context.limit, window, compact),
      limits: await read($, limits),
    }

    // One panel, two rows: row 1 is capacity (context, the 5-hour and weekly
    // windows), row 2 is right now (the turn, its tools, the prompt cache and
    // Hand off). Every gauge is the same line meter. Hovering an item shows
    // its detail laid over the other row, so nothing moves and the row under
    // the pointer stays usable. A terminal draws a border as three rows, so
    // there the panel goes borderless and the drawings become line glyphs.
    const isFramed = e.surface !== 'terminal'
    const hasHover = s.bar.hover

    // A detail, laid over a row while its item is hovered: the same height,
    // on a solid background. (The band clips anything drawn outside it, and
    // growing it makes it jump.)
    const overlay = (scope: string, content: ReturnType<typeof Text>) => (
      <Box
        key={`${scope}-detail`}
        position="absolute"
        top={0}
        bottom={0}
        left={0}
        right={0}
        overflow="hidden"
        display="none"
        hover={{ scope, display: 'flex' }}
        flexDirection="row"
        alignItems="center"
        backgroundColor="userMessageBackground"
      >
        {content}
      </Box>
    )

    const link = (key: string, label: string, onPress: () => unknown, dim = false) => (
      <Button
        key={key}
        label={label}
        plain
        {...(dim ? { dimColor: true } : {})}
        {...(hasHover ? { hover: { scope: `bar-link-${key}`, underline: true } } : {})}
        onPress={onPress}
      />
    )

    // An item of a row; its key is the hover scope its detail answers to.
    const segment = (scope: string, grow: boolean, content: RenderChildren[]) => (
      <Box
        key={scope}
        flexDirection="row"
        alignItems="center"
        columnGap={1}
        flexGrow={grow ? 1 : 0}
        flexShrink={grow ? 1 : 0}
        // A growing item gives up its room to the fixed ones, down to nothing,
        // instead of pushing the row past the edge.
        {...(grow ? { minWidth: 0, overflow: 'hidden' as const } : {})}
        {...(hasHover ? { hover: { scope } } : {})}
      >
        {content}
      </Box>
    )

    // The hairline between items. It never shrinks: when the row is short of
    // room the context meter gives way, and a shrinking hairline rounded
    // down to nothing.
    const rule = (key: string) => (
      <Box key={key} flexShrink={0}>
        {Svg ? (
          <Svg source={ruleSvg()} alt="│" width={1} height={16} />
        ) : (
          <Text dimColor>│</Text>
        )}
      </Box>
    )

    // The context meter fills the room between its label and its figures, so
    // the figures always show. The app draws it as one stretching SVG line
    // (meter.ts). The terminal splits its room between two glyph runs by
    // ratio, the used part in the level's colour and the rest a dim track, so
    // the meter stays true at any width.
    const contextMeter = (ratio: number) => {
      if (Svg) {
        return (
          <Box
            key="context-meter"
            flexDirection="column"
            justifyContent="center"
            alignItems="stretch"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            height={1}
            marginX={1}
          >
            <Svg
              source={meterSvg(ratio, level(ratio), { ticks: [s.levels.yellow, s.levels.orange, s.levels.red] })}
              alt={`${Math.round(ratio * 100)}% of the context used`}
              height={METER_HEIGHT}
            />
          </Box>
        )
      }

      const used = Math.round(Math.min(Math.max(ratio, 0), 1) * METER_STEPS)
      const run = '━'.repeat(METER_GLYPHS)
      const part = (key: string, grow: number, dim: boolean) => (
        <Box key={key} flexGrow={grow} flexShrink={1} width={0} minWidth={0} height={1} overflow="hidden">
          <Text color={level(ratio)} dimColor={dim}>
            {run}
          </Text>
        </Box>
      )

      return (
        <Box key="context-meter" flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden" marginX={1}>
          {used > 0 && part('context-used', used, false)}
          {used < METER_STEPS && part('context-rest', METER_STEPS - used, true)}
        </Box>
      )
    }

    // A plan window's short meter, with a "now" mark at how much of the
    // window has passed: fill beyond it means usage is ahead of the clock.
    const windowMeter = (key: string, ratio: number, cursor: number | null) => {
      if (Svg) {
        return (
          <Box key={key} flexShrink={0}>
            <Svg
              source={meterSvg(ratio, level(ratio), { cursor, pad: 5 })}
              alt={`${Math.round(ratio * 100)}% used${cursor === null ? '' : `, ${Math.round(cursor * 100)}% of the window passed`}`}
              width={WINDOW_METER_WIDTH}
              height={METER_HEIGHT}
            />
          </Box>
        )
      }

      const used = Math.round(Math.min(Math.max(ratio, 0), 1) * WINDOW_METER_CELLS)
      const mark = cursor === null ? -1 : Math.min(WINDOW_METER_CELLS - 1, Math.floor(cursor * WINDOW_METER_CELLS))

      return (
        <Text key={key}>
          {Array.from({ length: WINDOW_METER_CELLS }, (_, cell) =>
            cell === mark ? (
              <Text key={String(cell)}>┃</Text>
            ) : cell < used ? (
              <Text key={String(cell)} color={level(ratio)}>
                ━
              </Text>
            ) : (
              <Text key={String(cell)} dimColor>
                ─
              </Text>
            ),
          )}
        </Text>
      )
    }

    // How much of a window has passed, or null when unknown or turned off.
    const windowShare = (window: Limit) => {
      const span = WINDOW_MS[window.kind] ?? 0
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null

      return resetsAt && span ? Math.min(Math.max((now - (resetsAt - span)) / span, 0), 1) : null
    }

    const windowDetail = (window: Limit) => {
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null
      const share = windowShare(window) ?? 0
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
                {'  ·  '}
                {Math.round(share * 100)}% of the window passed{'  ·  '}resets{' '}
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

    const contextDetail = (data: BarData) => {
      const ratio = data.tokens / data.limit
      const tint = level(ratio)

      return overlay(
        'bar-context',
        <Text wrap="truncate-end">
          <Text bold>Context window</Text>
          <Text color={tint} dimColor>
            {'  ·  '}
          </Text>
          <Text color={tint}>
            {shortCount(data.tokens)} of {shortCount(data.limit)} tokens ({Math.round(ratio * 100)}%)
          </Text>
          <Text dimColor>
            {'  ·  '}
            {limitWords(s.context.limit, compact)}
            {s.context.click === 'usage' ? '  ·  click Context for /usage' : ''}
          </Text>
        </Text>,
      )
    }

    // The turn's figures, the number in the text colour and its label quiet.
    const figures = (tokens: Tokens, streaming = 0) =>
      s.turn.tokens && (
        <Text key="turn-figures">
          {(
            [
              [`${shortCount(tokens.output + streaming)}${streaming > 0 ? '+' : ''}`, 'out'],
              [shortCount(tokens.cacheRead), 'read'],
              [shortCount(tokens.cacheWrite), 'write'],
            ] as const
          ).map(([value, label], index) => (
            <Text key={label}>
              {index > 0 ? '   ' : ''}
              {value}
              <Text dimColor> {label}</Text>
            </Text>
          ))}
        </Text>
      )

    // The turn at the left of row 2, where it stays in view as replies
    // scroll: live while Claude works (a beat each second, the time, the
    // output rate), else the last finished one.
    const turnContent = (): RenderChildren[] => {
      if (running && s.turn.whileWorking) {
        const spark = Svg && liveTurn ? sparkSvg(liveTurn.rate, 'claude') : null

        return [
          Svg ? (
            <Svg key="beat" source={pulseSvg('claude')} alt="Working" width={14} height={14} />
          ) : (
            <Text key="beat" color="claude">
              ●
            </Text>
          ),
          <Text key="state" bold>
            Working
          </Text>,
          // Fixed width: the time changes every second, and the app's font
          // gives digits different widths.
          <Box key="time" width={TIMER_CELLS} flexShrink={0}>
            <Text color="claude" bold>
              {duration(elapsed)}
            </Text>
          </Box>,
          Svg && spark && (
            <Box key="spark" flexShrink={0}>
              <Svg source={spark} alt="Output tokens each second" width={SPARK_WIDTH} height={16} />
            </Box>
          ),
          liveTurn && figures(liveTurn.tokens, liveTurn.streaming),
        ]
      }

      if (!running && lastDone?.endedAt && s.turn.lastTurn) {
        return [
          Svg ? (
            <Svg key="beat" source={restingSvg()} alt="Idle" width={14} height={14} />
          ) : (
            <Text key="beat" dimColor>
              ○
            </Text>
          ),
          <Text key="state" dimColor>
            Last turn
          </Text>,
          <Text key="time" bold>
            {duration(lastDone.endedAt - lastDone.startedAt)}
          </Text>,
          lastDone.tokens && figures(lastDone.tokens),
        ]
      }

      return []
    }

    // Every figure of the turn, by its full name.
    const turnDetail = () => {
      const tokens = running ? liveTurn?.tokens : lastDone?.tokens
      const tools = running ? liveTurn?.tools : lastDone?.tools

      return (
        s.turn.tokens &&
        tokens &&
        overlay(
          'bar-turn',
          <Text wrap="truncate-end">
            <Text bold>{running ? 'This turn so far' : 'Last turn'}</Text>
            <Text dimColor>{'  ·  '}</Text>
            {shortCount(tokens.input)}
            <Text dimColor> in{'  ·  '}</Text>
            {shortCount(tokens.output)}
            <Text dimColor> out{'  ·  '}</Text>
            {shortCount(tokens.cacheRead)}
            <Text dimColor> cache read{'  ·  '}</Text>
            {shortCount(tokens.cacheWrite)}
            <Text dimColor> cache write</Text>
            {s.turn.toolCalls && typeof tools === 'number' && (
              <Text dimColor>
                {'  ·  '}
                {tools} tool {tools === 1 ? 'call' : 'calls'}
              </Text>
            )}
          </Text>,
        )
      )
    }

    const toolsItem = (tools: number) => {
      if (!s.turn.toolCalls) {
        return null
      }

      const label = `${tools} ${tools === 1 ? 'tool' : 'tools'}`

      return (
        <Box key="tools-slot" flexShrink={0}>
          {s.turn.toolCallsPanel ? (
            link('tools', `${label} ›`, () => $.ui.open({ id: 'bar-tools', title: 'Tool calls', focus: true }))
          ) : (
            <Text>{label}</Text>
          )}
        </Box>
      )
    }

    // The prompt cache: time left before the conversation drops out of it,
    // counted from the last response, and the Hand off button beside it,
    // drawn as the main action once the time is running out.
    const expiry = cacheExpiry(cache)
    const cacheSpan = cache ? expiry! - cache.at : 1
    const cacheLeft = expiry === null ? 0 : expiry - now
    const cacheRatio = 1 - Math.max(cacheLeft, 0) / cacheSpan
    const cacheTint = cacheLeft > 0 ? level(cacheRatio) : 'error'
    const isCacheUrgent = cacheTint === 'claude' || cacheTint === 'error'

    const cacheItem = () =>
      segment('bar-cache', false, [
        <Text key="label" dimColor>
          Cache
        </Text>,
        // Fixed width: the digits change every second.
        <Box key="left" width={Math.max(COUNTDOWN_CELLS, 'expired'.length)} flexShrink={0}>
          <Text color={cacheTint} bold>
            {cacheLeft > 0 ? countdown(cacheLeft) : 'expired'}
          </Text>
        </Box>,
      ])

    const handoffButton = () => (
      <Button
        key="handoff"
        label={HANDOFF_LABELS[handoff.status]}
        variant={isCacheUrgent ? 'primary' : 'secondary'}
        // The cache hooks start it on their next tick.
        onPress={() =>
          update($, handoffAtom, state =>
            state.status === 'idle' || state.status === 'error' || state.status === 'opened'
              ? { ...state, status: 'requested' as const }
              : state,
          )
        }
      />
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
      const windows = data.limits.filter(window =>
        window.kind === 'five_hour' ? s.planLimits.fiveHour : s.planLimits.weekly,
      )
      const contextLabel =
        s.context.click === 'usage' ? (
          link('context', 'Context', () => $.command.run({ command: 'usage', args: '' }), true)
        ) : (
          <Text key="context-label" dimColor>
            Context
          </Text>
        )

      const capacity: RenderChildren[] = []

      if (s.context.enabled) {
        capacity.push(
          segment('bar-context', true, [
            contextLabel,
            contextMeter(ratio),
            // Never shrinks: the meter gives up its room first.
            <Box key="context-figures" flexShrink={0}>
              <Text>
                <Text color={level(ratio)} bold>
                  {shortCount(data.tokens)}
                </Text>
                <Text dimColor> / {shortCount(data.limit)}  </Text>
                <Text color={level(ratio)}>{Math.round(ratio * 100)}%</Text>
              </Text>
            </Box>,
          ]),
        )
      }

      for (const window of windows) {
        const tint = level(window.percent / 100)

        capacity.push(
          segment(`bar-${window.kind}`, false, [
            <Text key="label" dimColor>
              {LIMIT_LABELS[window.kind]}
            </Text>,
            windowMeter('meter', window.percent / 100, s.planLimits.pace ? windowShare(window) : null),
            <Text key="percent" color={tint} bold>
              {Math.round(window.percent)}%
            </Text>,
            s.planLimits.resetTime && window.resetsAt && (
              <Text key={`bar-${window.kind}-reset`} dimColor>
                {resetTime(window.resetsAt, now)}
              </Text>
            ),
          ]),
        )
      }

      const tools = running ? (liveTurn?.tools ?? 0) : lastDone?.tools
      const nowItems: RenderChildren[] = []

      const turn = s.turn.enabled ? turnContent() : []

      if (turn.length > 0) {
        nowItems.push(segment('turn', true, turn))
        if (typeof tools === 'number') {
          nowItems.push(toolsItem(tools))
        }
      } else if (cache) {
        // Without the turn, the cache keeps to the right.
        nowItems.push(<Box key="turn-space" flexGrow={1} />)
      }

      if (cache) {
        nowItems.push(cacheItem())
      }

      const hasCapacity = capacity.length > 0
      const hasNow = nowItems.length > 0
      // Items with a hairline between each.
      const withRules = (row: string, items: RenderChildren[]) =>
        items.flatMap((item, index) => (index > 0 ? [rule(`${row}-rule-${index}`), item] : [item]))

      return (
        <Box
          key="bar-panel"
          flexDirection="column"
          {...(isFramed && s.bar.pillBorders ? { borderStyle: 'round', borderColor: PANEL_BORDER, paddingX: 1 } : {})}
        >
          {hasCapacity && (
            // The terminal draws the band's collapse control, `[-]`, over the
            // right end of the first row: keep those cells clear.
            <Box
              key="row-capacity"
              flexDirection="row"
              alignItems="center"
              columnGap={1}
              minHeight={1}
              paddingRight={isFramed ? 0 : COLLAPSE_CELLS}
            >
              {withRules('capacity', capacity)}
              {/* Last, so they paint over the row when shown: row 2's details. */}
              {hasHover && hasNow && cacheDetail()}
              {hasHover && hasNow && s.turn.enabled && turnDetail()}
            </Box>
          )}
          {hasCapacity && hasNow && Svg && (
            <Box key="row-rule" flexDirection="column" alignItems="stretch" marginY={0}>
              <Svg source={hruleSvg()} alt="—" height={1} />
            </Box>
          )}
          {hasNow && (
            <Box key="row-now" flexDirection="row" alignItems="center" columnGap={1} minHeight={1}>
              {withRules('now', nowItems.filter(item => item !== null))}
              {cache && s.cache.handoff && handoffButton()}
              {/* Row 1's details. */}
              {hasHover && hasCapacity && s.context.enabled && contextDetail(data)}
              {hasHover && hasCapacity && s.planLimits.hoverDetails && windows.map(window => windowDetail(window))}
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
