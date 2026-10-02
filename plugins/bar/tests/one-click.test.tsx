import { expect, mock, test } from 'claude-code/testing'

// The desktop app spends a click on a pane Button without the focus ring on
// moving the ring there. The panels press a button as the ring lands on it,
// and take the click straight after as the same one.
test('a panel button acts on the click that focuses it, once', async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-02T18:00:00Z') })
  const values = new Map<string, unknown>([
    [
      'calls',
      [
        {
          id: 'a',
          tool: 'Bash',
          summary: 'ls',
          input: '{}',
          output: '',
          status: 'done',
          startedAt: clock.now() - 2_000,
          ms: 40,
        },
      ],
    ],
    ['openCalls', []],
  ])
  on('state.get', (_$, e) => ({ value: { value: values.get((e as { key: string }).key), version: 1 } }) as never)
  on('state.set', (_$, e) => {
    const write = e as { key: string; value: unknown }
    values.set(write.key, write.value)
    return { value: { isSet: true, version: 1 } } as never
  })
  // The engine's own move of the ring, beneath the plugins.
  on('ui.focus', () => ({}) as never)

  const ui = await $.ui.mount({
    plugin: 'bar',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'bar-tools',
    props: {} as never,
  })
  const settle = () => clock.advance(10)

  // The click that brings the ring opens the call.
  await $.ui.focus({ component: 'Pane', requestId: 'bar-tools', plugin: 'bar', element: 'call-a', origin: { kind: 'person' } })
  await settle()
  expect(values.get('openCalls')).toEqual(['a'])

  // The press of that same click doesn't close it again.
  await ui.press({ key: 'call-a' })
  expect(values.get('openCalls')).toEqual(['a'])

  // A later click on the focused button presses it as usual.
  await clock.advance(2_000)
  await ui.press({ key: 'call-a' })
  expect(values.get('openCalls')).toEqual([])

  // The engine's own focus moves (autoFocus, $.ui.focus) press nothing.
  await $.ui.focus({ component: 'Pane', requestId: 'bar-tools', plugin: 'bar', element: 'call-a', origin: { kind: 'plugin' } as never })
  await settle()
  expect(values.get('openCalls')).toEqual([])
})
