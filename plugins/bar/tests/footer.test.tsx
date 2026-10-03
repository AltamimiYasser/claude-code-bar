import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The footer beneath Bar, as the engine draws it: the mode labels, joined by " & ".
const engineFooter = (on: On) =>
  on('ui.render', { component: 'SessionMode' }, (_$, e) => ({ type: 'Text', props: { dimColor: true }, children: [e.props.modes.join(' & ')] }) as never)

// The Remote Control toggle draws in the prompt footer on both surfaces that
// have one, in its "off" look before anything started. Nothing is pressed:
// the kit has no process access.
test('the footer shows the Remote Control toggle, off', async ($, on) => {
  engineFooter(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'bar',
      surface,
      component: 'SessionMode',
      props: { modes: ['focus'] },
    })

    expect((await ui.find({ key: 'remote-toggle' }))?.text).toBe('○ Remote')
    expect(await ui.find({ type: 'Text', text: 'focus' })).toBeDefined()
    await ui.unmount()
  }
})

// Another mod's button drawn in the footer stays, before Sessions and Remote,
// instead of being replaced by them.
test("another mod's footer button stays before Sessions and Remote", async ($, on) => {
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{e.props.modes.join(' & ')}</Text>
        <Button key="other-ci" label="CI ✓" plain onPress={() => undefined} />
      </Box>
    )
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'bar', surface, component: 'SessionMode', props: { modes: ['focus'] } })
    expect((await ui.find({ key: 'other-ci' }))?.text).toBe('CI ✓')
    expect(await ui.find({ type: 'Text', text: 'focus' })).toBeDefined()
    expect((await ui.find({ key: 'remote-toggle' }))?.text).toBe('○ Remote')
    await ui.unmount()
  }
})

// The bar itself draws on both surfaces; on the desktop its pills carry the
// translucent border colours, which the surface has to accept.
test('the bar draws its pills', async ($, on) => {
  mock.clock(on)
  // The engine draws nothing of its own in the band.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', props: {}, children: [] }) as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'bar',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 10, totalRows: 3 },
        view: {},
      } as never,
    })

    expect(await ui.find({ key: 'context' })).toBeDefined()
    await ui.unmount()
  }
})

// Another mod's card drawn in the band stays, above the bar, instead of being
// replaced by it.
test("another mod's card stays above the bar", async ($, on) => {
  mock.clock(on)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ['Next ticket card'] }) as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'bar',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 10,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 10, totalRows: 4 },
        view: {},
      } as never,
    })

    expect(await ui.find({ text: 'Next ticket card' })).toBeDefined()
    expect(await ui.find({ key: 'context' })).toBeDefined()
    await ui.unmount()
  }
})
