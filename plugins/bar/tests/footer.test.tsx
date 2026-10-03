import { expect, mock, test } from 'claude-code/testing'

// The Remote Control toggle draws in the prompt footer on both surfaces that
// have one, in its "off" look before anything started. Nothing is pressed:
// the kit has no process access.
test('the footer shows the Remote Control toggle, off', async $ => {
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
