import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionRateLimit,
} from 'claude-code'

import type { BarData, Changes, Fill, Limit, Place } from '../types'
import { colorFor, longDate, resetTime, shortCount, until } from './format'

// Where the context meter is full and red unless the person set their own
// (the `contextLimit` setting, or /bar-limit); never past the model's window.
const DEFAULT_LIMIT = 400_000
const MIN_LIMIT = 10_000
const CONTEXT_CELLS = 18
// A longer branch name keeps its start and end, cut in the middle.
const MAX_BRANCH = 24
const POLL_MS = 3_000
const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * 3_600_000,
  seven_day: 7 * 24 * 3_600_000,
}
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly limit',
}

const fill = atom({ plugin: 'bar', key: 'fill' } as const, null)
const place = atom({ plugin: 'bar', key: 'place' } as const, null)
const changes = atom({ plugin: 'bar', key: 'changes' } as const, null)
const limits = atom({ plugin: 'bar', key: 'limits' } as const, [])
const agents = atom({ plugin: 'bar', key: 'agents' } as const, 0)
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
    label: 'Plain folder, API key (no plan limits)',
    data: { tokens: 12_400, limit: 400_000, place: { folder: 'notes', root: '', branch: null, url: null }, changes: null, limits: [], agents: 0 },
  },
  {
    label: 'Clean repo, light use',
    data: {
      tokens: 148_000,
      limit: 400_000,
      place: { folder: 'my-app', root: '', branch: 'main', url: null },
      changes: { files: 0, added: 0, removed: 0 },
      limits: [
        { kind: 'five_hour', percent: 18, resetsAt: new Date(now + 3 * HOUR).toISOString() },
        { kind: 'seven_day', percent: 34, resetsAt: new Date(now + 80 * HOUR).toISOString() },
      ],
      agents: 0,
    },
  },
  {
    label: 'Uncommitted work, agents running, getting full',
    data: {
      tokens: 286_000,
      limit: 400_000,
      place: { folder: 'my-app', root: '', branch: 'feature/checkout-redesign-v2', url: null },
      changes: { files: 5, added: 142, removed: 37 },
      limits: [
        { kind: 'five_hour', percent: 62, resetsAt: new Date(now + 2 * HOUR).toISOString() },
        { kind: 'seven_day', percent: 71, resetsAt: new Date(now + 50 * HOUR).toISOString() },
      ],
      agents: 2,
    },
  },
  {
    label: 'Past the limit, detached HEAD, plan nearly used',
    data: {
      tokens: 431_000,
      limit: 400_000,
      place: { folder: 'docs-site', root: '', branch: 'a1b2c3d', url: null },
      changes: { files: 1, added: 3, removed: 0 },
      limits: [
        { kind: 'five_hour', percent: 96, resetsAt: new Date(now + 0.4 * HOUR).toISOString() },
        { kind: 'seven_day', percent: 88, resetsAt: new Date(now + 20 * HOUR).toISOString() },
      ],
      agents: 1,
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

const shortBranch = (name: string) =>
  name.length <= MAX_BRANCH
    ? name
    : `${name.slice(0, MAX_BRANCH - 9)}…${name.slice(-8)}`

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const git = async ($: EngineInterface, args: string[]) => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args], {
      timeoutMs: 2_000,
    })

    return exitCode === 0 ? stdout.trim() : null
  } catch {
    return null
  }
}

// The branch's page on GitHub, from an `origin` remote in any of git's
// spellings; null for another host or no remote.
const branchUrl = (remote: string | null, branch: string) => {
  const match = remote?.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/)

  return match ? `https://github.com/${match[1]}/${match[2]}/tree/${encodeURI(branch)}` : null
}

const findPlace = async ($: EngineInterface): Promise<Place> => {
  const root = await git($, ['rev-parse', '--show-toplevel'])
  const cwd = await $.session.cwd()

  if (root === null) {
    return { folder: basename(cwd), root: cwd, branch: null, url: null }
  }

  // A detached HEAD has no branch name; show the short commit instead.
  const named = await git($, ['branch', '--show-current'])
  const branch = named || (await git($, ['rev-parse', '--short', 'HEAD']))
  const remote = await git($, ['remote', 'get-url', 'origin'])

  return {
    folder: basename(root),
    root,
    branch: branch || null,
    url: named ? branchUrl(remote, named) : null,
  }
}

const findChanges = async ($: EngineInterface): Promise<Changes | null> => {
  const status = await git($, ['status', '--porcelain'])

  if (status === null) {
    return null
  }

  // Against HEAD counts staged and unstaged edits together; a repo with no
  // commit yet has no HEAD, so fall back to the index.
  const numstat =
    (await git($, ['diff', 'HEAD', '--numstat'])) ??
    (await git($, ['diff', '--numstat'])) ??
    ''
  let added = 0
  let removed = 0

  for (const line of numstat.split('\n')) {
    const [plus, minus] = line.split('\t')
    added += Number(plus) || 0
    removed += Number(minus) || 0
  }

  return { files: status ? status.split('\n').length : 0, added, removed }
}

const countAgents = async ($: EngineInterface) =>
  (await $.agent.list()).filter(agent => agent.status === 'running').length

let isRefreshing = false

// Writes only what moved, so the band redraws only when something changed.
const refresh = async ($: EngineInterface) => {
  if (isRefreshing) {
    return
  }

  isRefreshing = true

  try {
    const [foundPlace, foundChanges, running] = await Promise.all([
      findPlace($),
      findChanges($),
      countAgents($),
    ])

    if (!same(await read($, place), foundPlace)) {
      await update($, place, () => foundPlace)
    }
    if (!same(await read($, changes), foundChanges)) {
      await update($, changes, () => foundChanges)
    }
    if ((await read($, agents)) !== running) {
      await update($, agents, () => running)
    }
  } finally {
    isRefreshing = false
  }
}

export const registerBand: Register = (on, options) => {
  const configured =
    typeof options.contextLimit === 'number' ? options.contextLimit : DEFAULT_LIMIT

  on('session.start', async ($, e, next) => {
    // Each load starts on the live bar; /bar-demo brings the samples back.
    await update($, demo, () => -1)
    // Panels earlier versions opened and this one no longer draws.
    await $.ui.close({ id: 'bar-context' })
    await $.ui.close({ id: 'bar-file' })
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
    await refresh($)

    // Catches edits, branch switches and agents that finish between turns.
    $.clock.every(POLL_MS, () => void refresh($))

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

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    void refresh($)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, fill)
    const livePlace = await read($, place)
    const now = await $.clock.now()

    const live: BarData = {
      tokens: current?.tokens ?? 0,
      limit: Math.min(configured, current?.window ?? configured),
      place: livePlace,
      changes: await read($, changes),
      limits: await read($, limits),
      agents: await read($, agents),
    }

    // Line 1 is usage, each figure in a pill; line 2 is the workspace, each
    // part clickable. Hovering a pill shows its detail in line 2's place. A
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

    const pill = (
      scope: string,
      grow: boolean,
      content: ReturnType<typeof Text> | ReturnType<typeof Box>,
    ) => (
      <Box
        key={scope}
        flexGrow={grow ? 1 : 0}
        flexShrink={grow ? 1 : 0}
        paddingX={isFramed ? 1 : 0}
        {...(isFramed ? { borderStyle: 'round', borderColor: 'inactive' } : {})}
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

    const openPath = async (path: string) => {
      await $.process.run(['open', path || livePlace?.root || '.'])
    }

    const windowDetail = (window: Limit) => {
      const span = WINDOW_MS[window.kind] ?? 0
      const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : null
      const share = resetsAt && span ? (now - (resetsAt - span)) / span : 0
      // Where usage lands at reset if it keeps the pace it has had so far;
      // too early in the window to say anything useful before a tenth of it.
      const pace = share >= 0.1 ? Math.round(window.percent / share) : null

      return overlay(
        `bar-${window.kind}`,
        <Text wrap="truncate-end">
          <Text bold>{WINDOW_NAMES[window.kind]}</Text>
          <Text dimColor>{'  ·  '}</Text>
          <Text color={colorFor(window.percent / 100)}>{Math.round(window.percent)}% used</Text>
          {resetsAt && (
            <Text dimColor>
              {'  ·  resets '}
              {longDate(resetsAt)} (in {until(resetsAt - now)})
            </Text>
          )}
          {pace !== null && (
            <Text color={pace >= 100 ? 'error' : 'inactive'}>
              {'  ·  '}
              {pace >= 100 ? 'on pace to run out first' : `on pace for ~${pace}%`}
            </Text>
          )}
        </Text>,
      )
    }

    const bar = (data: BarData) => {
      const ratio = data.tokens / data.limit
      const context = line(ratio, CONTEXT_CELLS)
      const work = data.changes && data.changes.files > 0 ? data.changes : null
      const where = data.place
      const separator = (key: string) => (
        <Text key={key} dimColor>
          {'  ·  '}
        </Text>
      )

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {pill(
              'bar-context',
              true,
              <Box flexDirection="row">
                {link('context', 'Context', () => $.command.run({ command: 'usage', args: '' }), true)}
                <Box flexShrink={1} height={1} overflow="hidden">
                <Text wrap="truncate-end">
                <Text>{'  '}</Text>

                <Text color={colorFor(ratio)}>{context.used}</Text>
                <Text color="inactive">{context.rest}</Text>
                <Text color={ratio >= 1 ? 'error' : 'text'} bold>
                  {'  '}
                  {shortCount(data.tokens)}
                </Text>
                <Text dimColor> / {shortCount(data.limit)}</Text>
                </Text>
                </Box>
              </Box>,
            )}
            {data.limits.map(window =>
              pill(
                `bar-${window.kind}`,
                false,
                <Text>
                  <Text dimColor>{LIMIT_LABELS[window.kind]}  </Text>
                  <Text color={colorFor(window.percent / 100)}>
                    {Math.round(window.percent)}%
                  </Text>
                  {window.resetsAt && (
                    <Text dimColor> · {resetTime(window.resetsAt, now)}</Text>
                  )}
                </Text>,
              ),
            )}
          </Box>
          <Box flexDirection="row" paddingX={isFramed ? 1 : 0} height={1} overflow="hidden">
            {where && link('folder', where.folder, () => openPath(where.root))}
            {where?.branch && <Text dimColor>{'  '}</Text>}
            {where?.branch &&
              link(
                'branch',
                `⎇ ${shortBranch(where.branch)}`,
                () =>
                  where.url
                    ? $.process.run(['open', where.url])
                    : $.ui.toast('This branch has no GitHub page to open'),
                true,
              )}
            {work && separator('changes-gap')}
            {work && (
              <Text key="counts">
                <Text color="success">+{work.added}</Text>{' '}
                <Text color="error">−{work.removed}</Text>{'  '}
              </Text>
            )}
            {work &&
              link(
                'changes',
                `${work.files} ${work.files === 1 ? 'file' : 'files'}`,
                () => $.ui.open({ id: 'bar-changes', title: 'Changes' }),
                true,
              )}
            {data.agents > 0 && separator('agents-gap')}
            {data.agents > 0 &&
              link(
                'agents',
                `${data.agents} ${data.agents === 1 ? 'agent' : 'agents'}`,
                () => $.ui.open({ id: 'bar-agents', title: 'Agents' }),
                true,
              )}
            {/* Last, so they paint over the workspace items when shown. */}
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
