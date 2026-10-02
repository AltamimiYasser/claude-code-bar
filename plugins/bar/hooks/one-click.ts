import type { Register } from 'claude-code'

// One click for a panel's buttons. The desktop app spends the first click on
// a pane Button that doesn't hold the focus ring moving the ring onto it, and
// only the second presses it. Here the ring landing on a button by the
// person presses it at once; a press of the same button straight after (the
// click the person makes out of habit) is taken without running it again.
// The engine can't tell a click from Tab or the arrows, so moving the ring
// onto a button by keyboard presses it too.

// How long after a press on focus a press of the same button is the same click.
const SAME_CLICK_MS = 1_500

// Each panel's buttons, by key, as its latest drawing bound them.
const handlers = new Map<string, Map<string, () => unknown>>()
// The button each panel last pressed on focus, and when.
const pressedOnFocus = new Map<string, { element: string; at: number }>()

// Records what a button does for the focus hook, and returns it for onPress.
// Called while drawing: a drawing's buttons replace the last drawing's.
export const oneClick = (requestId: string) => {
  const own = new Map<string, () => unknown>()
  handlers.set(requestId, own)

  return (key: string, handler: () => unknown) => {
    own.set(key, handler)
    return handler
  }
}

export const registerOneClick = (on: Parameters<Register>[0], requestIds: readonly string[]) => {
  for (const requestId of requestIds) {
    on('ui.focus', { requestId }, async ($, e, next) => {
      const result = await next(e)
      const handler = e.origin.kind === 'person' && e.element ? handlers.get(requestId)?.get(e.element) : undefined

      if (handler && e.element) {
        pressedOnFocus.set(requestId, { element: e.element, at: await $.clock.now() })
        void handler()
      }

      return result
    })

    on('ui.press', { requestId }, async ($, e, next) => {
      const last = pressedOnFocus.get(requestId)

      if (last?.element === e.element && (await $.clock.now()) - last.at < SAME_CLICK_MS) {
        pressedOnFocus.delete(requestId)
        return { element: e.element }
      }

      return next(e)
    })
  }
}
