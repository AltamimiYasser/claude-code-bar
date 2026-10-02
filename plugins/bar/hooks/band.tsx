import { atom, read, update } from 'claude-code'
import type {
  Register,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { BarData, Fill, Limit, Tokens, Turn } from '../types'
import { colorFor, duration, longDate, resetTime, shortCount, until } from './format'

// Where the context meter is full and red unless the person set their own
// (the `contextLimit` setting, or /bar-limit); never past the model's window.
const DEFAULT_LIMIT = 400_000
const MIN_LIMIT = 10_000
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
// The turn timer's values (written by the turn hooks): the bar shows the
// running turn's time and tokens while Claude works.
const turnList = atom({ plugin: 'bar', key: 'turns' } as const, [])
const tickedAt = atom({ plugin: 'bar', key: 'now' } as const, 0)
const turnTokens = atom({ plugin: 'bar', key: 'live' } as const, null)
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

export const registerBand: Register = (on, options) => {
  const configured =
    typeof options.contextLimit === 'number' ? options.contextLimit : DEFAULT_LIMIT

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
      description: 'Set where the context meter turns red, e.g. /bar-limit 300k',
    })
    await $.command.register({
      name: 'bar-demo',
      description: 'Step through sample bars, then back to the live one',
    })

    const usage = await $.session.usage()
    await update($, fill, () => toFill(usage.context))
    await update($, limits, () => toLimits(usage.rateLimits))

    return next(e)
  })

  on('command.run', { command: 'bar-limit' }, async ($, e) => {
    const wanted = parseCount(e.args)

    if (wanted === null) {
      return {
        text: `The context meter fills at ${shortCount(configured)} tokens. Change it with /bar-limit 300k.`,
      }
    }

    const window = (await read($, fill))?.window ?? Infinity
    const limit = Math.max(MIN_LIMIT, Math.min(wanted, window))
    const result = await $.config.set({ key: 'bar.contextLimit', value: limit })

    return {
      text:
        'deny' in result && result.deny
          ? `Couldn't change the limit: ${result.deny}`
          : `The context meter now fills at ${shortCount(limit)} tokens${limit < wanted ? ` (capped at the model's ${shortCount(limit)} window)` : ''}.`,
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
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, fill)
    const allTurns = await read($, turnList)
    const running = allTurns.findLast(turn => turn.endedAt === null)
    const lastDone = running ? undefined : allTurns.findLast(turn => turn.endedAt !== null)
    // Read only while a turn runs, so an idle bar does not redraw each second.
    const elapsed = running ? (await read($, tickedAt)) - running.startedAt : 0
    const liveTurn = running ? await read($, turnTokens) : null
    const now = await $.clock.now()

    const live: BarData = {
      tokens: current?.tokens ?? 0,
      limit: Math.min(configured, current?.window ?? configured),
      limits: await read($, limits),
    }

    // Line 1 is usage, each figure in a pill; line 2 is the turn (live while
    // Claude works, else the last one). Hovering a pill
    // shows its detail in line 2's place, which is why line 2 always stays. A
    // terminal draws a border as three rows, so there the pills go borderless.
    const isFramed = e.surface !== 'terminal'

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
    // orange, red), soft until it nears the limit: from 75% it shows at full
    // strength.
    const border = (ratio: number) => ({
      borderColor: colorFor(ratio),
      borderDimColor: ratio < 0.75,
    })

    const pill = (
      scope: string,
      grow: boolean,
      content: ReturnType<typeof Text> | ReturnType<typeof Box>,
      edge: { borderColor: string; borderDimColor: boolean },
    ) => (
      <Box
        key={scope}
        flexGrow={grow ? 1 : 0}
        flexShrink={grow ? 1 : 0}
        paddingX={isFramed ? 1 : 0}
        {...(isFramed ? { borderStyle: 'round', ...edge } : {})}
        hover={isFramed ? { scope, borderColor: 'suggestion' } : { scope }}
      >
        {content}
      </Box>
    )

    const link = (key: string, label: string, onPress: () => unknown, dim = false) => (
      <Button
        key={key}
        label={label}
        plain
        dimColor={dim}
        hover={{ scope: `bar-link-${key}`, underline: true, dimColor: false }}
        onPress={onPress}
      />
    )

    const windowDetail = (window: Limit) => {
      const span = WINDOW_MS[window.kind] ?? 0
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null
      const share = resetsAt && span ? (now - (resetsAt - span)) / span : 0
      // Where usage lands at reset if it keeps the pace it has had so far;
      // too early in the window to say anything useful before a tenth of it.
      const pace = share >= 0.1 ? Math.round(window.percent / share) : null
      const tint = colorFor(window.percent / 100)

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

    const tokenFigures = (tokens: Tokens, streaming = 0) => [
      figure('in', shortCount(tokens.input), 'in'),
      figure('out', `${shortCount(tokens.output + streaming)}${streaming > 0 ? '+' : ''}`, 'out'),
      figure('read', shortCount(tokens.cacheRead), 'cache read'),
      figure('write', shortCount(tokens.cacheWrite), 'cache write'),
    ]

    const toolFigure = (tools: number) => (
      <Box key="tools" flexGrow={1} flexShrink={0} justifyContent="flex-end" paddingLeft={3}>
        {link(
          'tools',
          `${tools} ${tools === 1 ? 'tool call' : 'tool calls'}`,
          () => $.ui.open({ id: 'bar-tools', title: 'Tool calls', focus: true }),
        )}
      </Box>
    )

    // The turn at the left of line 2, where it stays in view as replies
    // scroll: live while Claude works, else the last finished one.
    const turnLine = () => {
      if (running) {
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

      if (lastDone?.endedAt) {
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

    const bar = (data: BarData) => {
      const ratio = data.tokens / data.limit
      const context = line(ratio, CONTEXT_CELLS)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {pill(
              'bar-context',
              true,
              <Box flexDirection="row">
                {link('context', 'Context', () => $.command.run({ command: 'usage', args: '' }))}
                <Box flexShrink={1} height={1} overflow="hidden">
                <Text wrap="truncate-end">
                <Text>{'  '}</Text>

                <Text color={colorFor(ratio)}>{context.used}</Text>
                <Text color={colorFor(ratio)} dimColor>
                  {context.rest}
                </Text>
                <Text color={colorFor(ratio)} bold>
                  {'  '}
                  {shortCount(data.tokens)}
                </Text>
                <Text color={colorFor(ratio)} dimColor>
                  {' '}/ {shortCount(data.limit)}
                </Text>
                </Text>
                </Box>
              </Box>,
              border(ratio),
            )}
            {data.limits.map(window =>
              pill(
                `bar-${window.kind}`,
                false,
                <Text>
                  <Text>{LIMIT_LABELS[window.kind]}  </Text>
                  <Text color={colorFor(window.percent / 100)}>
                    {Math.round(window.percent)}%
                  </Text>
                  {window.resetsAt && (
                    <Text color={colorFor(window.percent / 100)} dimColor>
                      {' '}· {resetTime(window.resetsAt, now)}
                    </Text>
                  )}
                </Text>,
                border(window.percent / 100),
              ),
            )}
          </Box>
          <Box flexDirection="row" paddingX={isFramed ? 1 : 0} height={1} overflow="hidden">
            {turnLine()}
            {/* Last, so they paint over line 2 when shown. */}
            {data.limits.map(window => windowDetail(window))}
          </Box>
        </Box>
      )
    }

    const sample = samples(now)[demoIndex(await read($, demo))]

    if (!sample) {
      return bar(live)
    }

    return bar(sample.data)
  })
}
