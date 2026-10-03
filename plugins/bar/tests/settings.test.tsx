import { describe, expect, mock, test } from 'claude-code/testing'

import type { BarSettings, Turn } from '../types'
import { DEFAULTS, parseJsonc, TEMPLATE, toSettings, withLimit } from '../hooks/settings'
import { meterSvg, sparkSvg } from '../hooks/meter'

// Each option of ~/.claude/bar/settings.jsonc, one at a time: the test puts
// the settings (and the figures the bar draws from) into the mod's state,
// draws the part of the app the option belongs to, and checks it. The kit
// has no state store, so the test answers state.get and state.set from a map.

const NOW = Date.parse('2026-10-02T18:00:00Z')
const HOUR = 3_600_000

type Patch = { [K in keyof BarSettings]?: Partial<BarSettings[K]> | BarSettings[K] }

const settingsWith = (patch: Patch): BarSettings => {
  const out = structuredClone(DEFAULTS) as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    const base = out[key]
    out[key] = typeof value === 'object' && value !== null ? { ...(base as object), ...value } : value
  }
  return out as BarSettings
}

const finished: Turn = {
  id: 'turn-1',
  prompt: 'hello',
  startedAt: NOW - 40_000,
  endedAt: NOW - 3_000,
  answer: 'The final answer.',
  isAborted: false,
  tokens: { input: 12, output: 3_400, cacheRead: 2_900_000, cacheWrite: 4_000 },
  tools: 9,
}

const running: Turn = { ...finished, id: 'turn-2', endedAt: null, answer: null, tokens: null, tools: 0 }

type On = Parameters<Parameters<typeof test>[1]>[1]
type Put = (key: string, value: unknown) => void

// A drawn element's hover styles sit beside its props, and only an
// element's parent lists them: whether any hover scope shows in its tree.
const hoverOf = (element: unknown) => (JSON.stringify(element ?? null).includes('"hover"') ? true : undefined)

// The mod's state, kept in a map the test answers state reads and writes from.
const memoryState = (on: On): Put => {
  const values = new Map<string, unknown>()
  // The band beneath the bar: the engine draws nothing of its own there (an
  // empty Box), unless a test answers with a drawing of its own.
  on('ui.render', { component: 'AbovePrompt' }, async (_$, e, next) => {
    try {
      return await next(e)
    } catch {
      return { type: 'Box', props: {}, children: [] } as never
    }
  })
  // A hook standing for the engine answers an engine call as { value }.
  on('state.get', (_$, e) => ({ value: { value: values.get((e as { key: string }).key), version: 1 } }) as never)
  on('state.set', (_$, e) => {
    const write = e as { key: string; value: unknown }
    values.set(write.key, write.value)
    return { value: { isSet: true, version: 1 } } as never
  })
  return (key, value) => values.set(key, value)
}

// The state the bar reads: settings, the context fill, the plan windows and
// the turns; `isWorking` puts a running turn last.
const seed = async (put: Put, patch: Patch = {}, isWorking = false) => {
  put('settings', settingsWith(patch))
  put('fill', { tokens: 100_000, window: 1_000_000 })
  put('compactWindow', null)
  put('limits', [
    { kind: 'five_hour', percent: 40, resetsAt: new Date(NOW + HOUR).toISOString() },
    { kind: 'seven_day', percent: 64, resetsAt: new Date(NOW + 30 * HOUR).toISOString() },
  ])
  put('turns', isWorking ? [finished, running] : [finished])
  put('demo', -1)
  put('cache', null)
  put('handoff', { status: 'idle', path: null, clickedAt: null, turnId: null, detail: null })
}

const BAND = {
  plugin: 'bar',
  surface: 'desktop',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10, totalRows: 3 },
    view: {},
  } as never,
} as const

// The engine's own drawing, for when the mod passes: a test answers beneath
// the plugins in its place.
const engineDraws = (on: On, text: string) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{text}</Text>
  })

describe('bar', () => {
  test('bar.enabled: false leaves the band to the app', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    engineDraws(on, 'engine band')
    await seed(put, { bar: { enabled: false } })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-context' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  })

  test('bar.hover: false takes every hover off the pills', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect(hoverOf(await ui.find({ key: 'bar-context' }))).toBeDefined()
    expect(await ui.find({ key: 'bar-five_hour-detail' })).toBeDefined()
    await ui.unmount()

    await seed(put, { bar: { hover: false } })
    ui = await $.ui.mount(BAND)
    expect(hoverOf(await ui.find({ key: 'bar-context' }))).toBeUndefined()
    expect(hoverOf(await ui.find({ key: 'tools-slot' }))).toBeUndefined()
    expect(await ui.find({ key: 'bar-five_hour-detail' })).toBeUndefined()
  })

  test('bar.pillBorders: false draws the panel without an outline', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'bar-panel' }))?.props.borderStyle).toBe('round')
    await ui.unmount()

    await seed(put, { bar: { pillBorders: false } })
    ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'bar-panel' }))?.props.borderStyle).toBeUndefined()
  })
})

describe('context', () => {
  test('context.enabled: false removes the context pill', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { context: { enabled: false } })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-context' })).toBeUndefined()
    expect(await ui.find({ key: 'bar-five_hour' })).toBeDefined()
  })

  test('context.limit: "autoCompact" fills at the auto-compact window, else the model window', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /\/ 1\.0M/ })).toBeDefined()
    await ui.unmount()

    put('compactWindow', { tokens: 400_000, source: 'settings' })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /\/ 400k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /your auto-compact window/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { context: { limit: 'model' } })
    put('compactWindow', { tokens: 400_000, source: 'settings' })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /\/ 1\.0M/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { context: { limit: 400_000 } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /\/ 400k/ })).toBeDefined()
  })

  test('context.limit past the model window is capped at the window', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { context: { limit: 5_000_000 } })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /\/ 1\.0M/ })).toBeDefined()
  })

  test('the pill shows the count and its percentage, which never shrink', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { context: { limit: 400_000 } })
    put('fill', { tokens: 286_000, window: 1_000_000 })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect((await ui.find({ key: 'context-figures' }))?.props.flexShrink).toBe(0)
      expect(await ui.find({ type: 'Text', text: '286k / 400k  72%' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the app draws the meter as one stretching SVG line', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { context: { limit: 400_000 } })
    put('fill', { tokens: 286_000, window: 1_000_000 })
    const ui = await $.ui.mount(BAND)
    const svg = await ui.find({ type: 'Svg' })
    expect(svg?.props.alt).toBe('72% of the context used')
    // The fill and the bead stop at 71.5%, in the orange of that level.
    expect(String(svg?.props.source)).toContain('* 0.715)')
    expect(String(svg?.props.source)).toContain('rgb(202, 138, 4)')
    // Only the ticks still ahead show: orange (75%), not yellow (50%).
    expect(String(svg?.props.source).match(/<rect style="x:calc\(calc/g)?.length).toBe(1)
    expect(await ui.find({ key: 'context-used' })).toBeUndefined()
  })

  test('the terminal splits the meter by the same share', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { context: { limit: 400_000 } })
    put('fill', { tokens: 286_000, window: 1_000_000 })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    // 715 of 1000 steps used.
    expect((await ui.find({ key: 'context-used' }))?.props.flexGrow).toBe(715)
    expect((await ui.find({ key: 'context-rest' }))?.props.flexGrow).toBe(285)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  })

  test('past the limit the meter is full and the percentage goes over 100', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { context: { limit: 400_000 } })
    put('fill', { tokens: 431_000, window: 1_000_000 })
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: '431k / 400k  108%' })).toBeDefined()
    expect(String((await ui.find({ type: 'Svg' }))?.props.source)).toContain('* 1)')
    await ui.unmount()

    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'context-rest' })).toBeUndefined()
  })

  test('context.click: "none" makes the label plain text', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'context' }))?.type).toBe('Button')
    await ui.unmount()

    await seed(put, { context: { click: 'none' } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'context' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
  })
})

describe('planLimits', () => {
  test('planLimits.fiveHour and weekly hide their pills', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { planLimits: { fiveHour: false } })
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-five_hour' })).toBeUndefined()
    expect(await ui.find({ key: 'bar-seven_day' })).toBeDefined()
    await ui.unmount()

    await seed(put, { planLimits: { weekly: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-five_hour' })).toBeDefined()
    expect(await ui.find({ key: 'bar-seven_day' })).toBeUndefined()
  })

  test('planLimits.resetTime: false drops the reset time from the pills', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    // The 5-hour window resets within the day: a clock time.
    expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d$/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { planLimits: { resetTime: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /^\d\d:\d\d$/ })).toBeUndefined()
  })

  test('planLimits.hoverDetails: false drops the hover rows', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { planLimits: { hoverDetails: false } })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-five_hour-detail' })).toBeUndefined()
    expect(await ui.find({ key: 'bar-five_hour' })).toBeDefined()
  })

  test('planLimits.pace: false drops the pace estimate', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /on pace/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { planLimits: { pace: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /on pace/ })).toBeUndefined()
  })
})

describe('turn', () => {
  test('turn.enabled: false removes line 2', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { turn: { enabled: false } })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'turn' })).toBeUndefined()
    expect(await ui.find({ key: 'tools-slot' })).toBeUndefined()
  })

  test('turn.lastTurn: false hides the last turn between turns', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Last turn/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { turn: { lastTurn: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'turn' })).toBeUndefined()
  })

  test('turn.whileWorking: false hides the live turn', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, {}, true)
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { turn: { whileWorking: false } }, true)
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /Working/ })).toBeUndefined()
  })

  test('turn.tokens: false drops the token figures', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /cache read/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { turn: { tokens: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /cache read/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Last turn/ })).toBeDefined()
  })

  test('turn.toolCalls: false drops the count', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { turn: { toolCalls: false } })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: /tool calls?$/ })).toBeUndefined()
    expect(await ui.find({ key: 'tools' })).toBeUndefined()
  })

  test('turn.toolCallsPanel: false makes the count plain text', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'tools' }))?.type).toBe('Button')
    await ui.unmount()

    await seed(put, { turn: { toolCallsPanel: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'tools' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^9 tools$/ })).toBeDefined()
  })
})

describe('levels', () => {
  test('levels move where the colors change', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    expect((await ui.find({ type: 'Text', text: /^100k$/ }))?.props.color).toBe('success')
    await ui.unmount()

    await seed(put, { levels: { yellow: 0.05, orange: 0.08, red: 0.5 } })
    ui = await $.ui.mount(BAND)
    expect((await ui.find({ type: 'Text', text: /^100k$/ }))?.props.color).toBe('claude')
  })
})

describe('answer and spinner', () => {
  const ANSWER = {
    plugin: 'bar',
    surface: 'desktop',
    component: 'AssistantMessage',
    props: { text: 'The final answer.', isFirstOfReply: true },
  } as const

  test('answer.frame, footer and footerTokens each switch their part', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(ANSWER)
    expect(await ui.find({ type: 'Text', text: /Answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cache write/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { answer: { frame: false } })
    ui = await $.ui.mount(ANSWER)
    expect(await ui.find({ type: 'Text', text: /Answer/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { answer: { footerTokens: false } })
    ui = await $.ui.mount(ANSWER)
    expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cache write/ })).toBeUndefined()
    await ui.unmount()

    await seed(put, { answer: { footer: false } })
    ui = await $.ui.mount(ANSWER)
    expect(await ui.find({ type: 'Text', text: /Answer/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Done in/ })).toBeUndefined()
  })

  test('spinnerTimer: false leaves the working indicator as the app draws it', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      const suffix = (e.props as { suffix?: string }).suffix ?? ''
      return <Text>{`Thinking${suffix}`}</Text>
    })
    const SPINNER = {
      plugin: 'bar',
      surface: 'desktop',
      component: 'Spinner',
      props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
    } as const

    await seed(put, {}, true)
    let ui = await $.ui.mount(SPINNER)
    expect(await ui.find({ type: 'Text', text: /Thinking… 40s/ })).toBeDefined()
    await ui.unmount()

    await seed(put, { spinnerTimer: false }, true)
    ui = await $.ui.mount(SPINNER)
    expect(await ui.find({ type: 'Text', text: 'Thinking…' })).toBeDefined()
  })
})

describe('remote', () => {
  const FOOTER = {
    plugin: 'bar',
    surface: 'desktop',
    component: 'SessionMode',
    props: { modes: [] },
  } as const

  test('remote.enabled: false leaves the footer to the app', async ($, on) => {
    const put = memoryState(on)
    engineDraws(on, 'engine footer')
    await seed(put, { remote: { enabled: false } })
    const ui = await $.ui.mount(FOOTER)
    expect(await ui.find({ key: 'remote-toggle' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine footer' })).toBeDefined()
  })

  test('the toggle is one button carrying a green mark while on', async ($, on) => {
    const put = memoryState(on)
    await seed(put)
    put('remote', { status: 'on', url: null, detail: null })
    const ui = await $.ui.mount(FOOTER)
    expect((await ui.find({ key: 'remote-toggle' }))?.text).toBe('🟢 Remote')
  })

  test('a stopping instance offers nothing until it has exited', async ($, on) => {
    mock.clock(on, { now: NOW })
    const put = memoryState(on)
    await seed(put)
    put('remoteAll', [
      { key: 'going', cwd: '/p/app', name: 'app', status: 'stopping', url: null, detail: null, pid: null, startedAt: NOW - HOUR, stoppedAt: NOW - 3_000, isExternal: false },
    ])
    const ui = await $.ui.mount({ plugin: 'bar', surface: 'desktop', component: 'Pane', requestId: 'bar-remote', props: {} as never })
    expect(await ui.find({ type: 'Text', text: 'stopping…' })).toBeDefined()
    expect(await ui.find({ key: 'remote-stop-going' })).toBeUndefined()
    expect(await ui.find({ key: 'remote-start-going' })).toBeUndefined()
    expect(await ui.find({ key: 'remote-forget-going' })).toBeUndefined()
  })

  test('remote.sessionsButton: false drops the Remote sessions button', async ($, on) => {
    const put = memoryState(on)
    await seed(put)
    let ui = await $.ui.mount(FOOTER)
    expect((await ui.find({ key: 'remote-sessions' }))?.text).toBe('Sessions')
    await ui.unmount()

    await seed(put, { remote: { sessionsButton: false } })
    ui = await $.ui.mount(FOOTER)
    expect(await ui.find({ key: 'remote-sessions' })).toBeUndefined()
    expect(await ui.find({ key: 'remote-toggle' })).toBeDefined()
  })

  test('the Remote sessions panel offers what each instance can do', async ($, on) => {
    mock.clock(on, { now: NOW })
    const put = memoryState(on)
    await seed(put)
    const base = { url: null, detail: null, stoppedAt: null, isExternal: false }
    put('remoteAll', [
      { ...base, key: 'running', cwd: '/p/app', name: 'app', status: 'on', url: 'https://claude.ai/code?environment=env_a', pid: 11, startedAt: NOW - HOUR },
      { ...base, key: 'old', cwd: '/p/site', name: 'site', status: 'stopped', pid: null, startedAt: NOW - 5 * HOUR, stoppedAt: NOW - 2 * HOUR },
      { ...base, key: 'pid-22', cwd: null, name: 'notes', status: 'on', pid: 22, startedAt: null, isExternal: true },
    ])
    const ui = await $.ui.mount({ plugin: 'bar', surface: 'desktop', component: 'Pane', requestId: 'bar-remote', props: {} as never })

    expect(await ui.find({ key: 'remote-stop-running' })).toBeDefined()
    expect(await ui.find({ key: 'remote-start-running' })).toBeUndefined()
    expect(await ui.find({ key: 'remote-start-old' })).toBeDefined()
    expect(await ui.find({ key: 'remote-forget-old' })).toBeDefined()
    expect(await ui.find({ key: 'remote-stop-old' })).toBeUndefined()
    expect(await ui.find({ key: 'remote-stop-pid-22' })).toBeDefined()
    expect(await ui.find({ key: 'remote-forget-pid-22' })).toBeUndefined()
    expect(await ui.find({ key: 'remote-stop-all' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /stopped (at \d\d:\d\d|\w{3} \d+ \w{3}, \d\d:\d\d) · ran 3h 0m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /running 1h 0m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / ago/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /started outside Bar/ })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
  })

  test('bar.hover: false takes the hover off the toggle', async ($, on) => {
    const put = memoryState(on)
    await seed(put)
    let ui = await $.ui.mount(FOOTER)
    expect(hoverOf(await ui.find({ key: 'remote-footer' }))).toBeDefined()
    await ui.unmount()

    await seed(put, { bar: { hover: false } })
    ui = await $.ui.mount(FOOTER)
    expect(hoverOf(await ui.find({ key: 'remote-footer' }))).toBeUndefined()
  })
})

describe('the settings file', () => {
  test('the template parses to exactly the defaults', () => {
    expect(toSettings(parseJsonc(TEMPLATE))).toEqual(DEFAULTS)
  })

  test('comments, trailing commas and slashes inside strings parse', () => {
    const parsed = parseJsonc('{ "a": "http://x // not a comment", /* gone */ "b": [1, 2,], }')
    expect(parsed).toEqual({ a: 'http://x // not a comment', b: [1, 2] })
  })

  test('a wrong type or an unknown word falls back to the default', () => {
    const settings = toSettings({
      bar: { enabled: 'yes' },
      context: { limit: -5, click: 'open' },
      remote: { autoStart: 'sometimes' },
      levels: { yellow: 'high' },
    })
    expect(settings.bar.enabled).toBe(true)
    expect(settings.context.limit).toBe('autoCompact')
    expect(settings.context.click).toBe('usage')
    expect(settings.remote.autoStart).toBe('newProjects')
    expect(settings.levels.yellow).toBe(0.5)
  })

  test('each autoStart word is kept', () => {
    for (const word of ['never', 'newProjects', 'always'] as const) {
      expect(toSettings({ remote: { autoStart: word } }).remote.autoStart).toBe(word)
    }
  })

  test('/bar-limit rewrites only the limit, keeping the comments', () => {
    const text = withLimit(TEMPLATE, 300_000) ?? ''
    expect(text).toContain('"limit": 300000,')
    expect(text).toContain('// Bar settings.')
    expect(toSettings(parseJsonc(text)).context.limit).toBe(300_000)
    const model = withLimit(text, 'model') ?? ''
    expect(model).toContain('"limit": "model",')
    expect(toSettings(parseJsonc(model)).context.limit).toBe('model')
    expect(toSettings(parseJsonc(withLimit(model, 'autoCompact') ?? '')).context.limit).toBe('autoCompact')
  })

  test('an older file with "limit": null follows the auto-compact window', () => {
    expect(toSettings({ context: { limit: null } }).context.limit).toBe('autoCompact')
    expect(toSettings(parseJsonc(TEMPLATE)).context.limit).toBe('autoCompact')
  })
})

describe('cache', () => {
  test('no response yet: no cache pill', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-cache' })).toBeUndefined()
  })

  test('the cache pill counts down from the last response, with Hand off beside it', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW - 10 * 60_000 - 15_000, ttl: '1h' })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-cache' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '49:45' })).toBeDefined()
    expect((await ui.find({ key: 'handoff' }))?.props.label).toBe('Hand off →')
    expect(await ui.find({ key: 'bar-cache-detail' })).toBeDefined()
  })

  test('a 5-minute cache past its time reads expired', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW - 6 * 60_000, ttl: '5m' })
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: 'expired' })).toBeDefined()
  })

  test('the button shows the handoff while it is written', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW, ttl: '1h' })
    put('handoff', { status: 'writing', path: '/tmp/h.md', clickedAt: NOW, turnId: null, detail: null })
    const ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'handoff' }))?.props.label).toBe('Writing…')
  })

  test('pressing Hand off asks for the handoff', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW, ttl: '1h' })
    let ui = await $.ui.mount(BAND)
    await ui.press({ key: 'handoff' })
    // The test's state store doesn't redraw on a write: draw again.
    await ui.unmount()
    ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'handoff' }))?.props.label).toBe('Writing…')
  })

  test('cache.enabled: false hides the pill, cache.handoff: false the button', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, { cache: { enabled: false } })
    put('cache', { at: NOW, ttl: '1h' })
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-cache' })).toBeUndefined()
    await ui.unmount()

    await seed(put, { cache: { handoff: false } })
    put('cache', { at: NOW, ttl: '1h' })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ key: 'bar-cache' })).toBeDefined()
    expect(await ui.find({ key: 'handoff' })).toBeUndefined()
  })
})

describe('the panel', () => {
  test('row 1 holds capacity, row 2 the turn, the cache and Hand off', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW - 10 * 60_000, ttl: '1h' })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const capacity = JSON.stringify(await ui.find({ key: 'row-capacity' }))
      const current = JSON.stringify(await ui.find({ key: 'row-now' }))
      for (const key of ['bar-context', 'bar-five_hour', 'bar-seven_day']) {
        expect(capacity).toContain(`"${key}"`)
      }
      for (const key of ['turn', 'tools-slot', 'bar-cache', 'handoff']) {
        expect(current).toContain(`"${key}"`)
      }
      await ui.unmount()
    }
  })

  test('the 5h meter marks how much of the window has passed', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    let ui = await $.ui.mount(BAND)
    // Resets in an hour: 4 of its 5 hours have passed.
    expect(await ui.find({ type: 'Svg', props: { alt: '40% used, 80% of the window passed' } })).toBeDefined()
    await ui.unmount()

    await seed(put, { planLimits: { pace: false } })
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Svg', props: { alt: '40% used' } })).toBeDefined()
    await ui.unmount()

    // The terminal draws the mark as a tall bar in the line.
    await seed(put)
    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /┃/ })).toBeDefined()
  })

  test('a running turn beats, a finished one rests', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put, {}, true)
    let ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Svg', props: { alt: 'Working' } })).toBeDefined()
    await ui.unmount()

    await seed(put)
    ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Svg', props: { alt: 'Idle' } })).toBeDefined()
  })

  test('Hand off becomes the main action as the cache runs out', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW - 10 * 60_000, ttl: '1h' })
    let ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'handoff' }))?.props.variant).toBe('secondary')
    await ui.unmount()

    // 50 of its 60 minutes gone: past the orange level.
    put('cache', { at: NOW - 50 * 60_000, ttl: '1h' })
    ui = await $.ui.mount(BAND)
    expect((await ui.find({ key: 'handoff' }))?.props.variant).toBe('primary')
  })

  test('hovering an item lays its detail over the other row', async ($, on) => {
    const put = memoryState(on)
    mock.clock(on, { now: NOW })
    await seed(put)
    put('cache', { at: NOW, ttl: '1h' })
    const ui = await $.ui.mount(BAND)
    const capacity = JSON.stringify(await ui.find({ key: 'row-capacity' }))
    const current = JSON.stringify(await ui.find({ key: 'row-now' }))
    expect(capacity).toContain('"bar-cache-detail"')
    expect(capacity).toContain('"bar-turn-detail"')
    expect(current).toContain('"bar-context-detail"')
    expect(current).toContain('"bar-five_hour-detail"')
  })
})

describe('the drawings', () => {
  test('the sparkline needs two samples and ends in the bead', () => {
    expect(sparkSvg([], 'claude')).toBeNull()
    expect(sparkSvg([4], 'claude')).toBeNull()
    const svg = sparkSvg([0, 4, 9, 3], 'claude') ?? ''
    expect(svg).toContain('<path')
    expect(svg).toContain('rgb(217, 119, 87)')
  })

  test('the meter draws its "now" mark only when given one', () => {
    expect(meterSvg(0.3, 'success', { cursor: 0.5 })).toContain('height:10px')
    expect(meterSvg(0.3, 'success', {})).not.toContain('height:10px')
  })
})
