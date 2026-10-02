import type { Register } from 'claude-code'

import { registerBand } from './band'
import { registerOneClick } from './one-click'
import { PANEL as REMOTE_PANEL, registerRemote } from './remote'
import { registerTools, TOOLS_PANEL } from './tools'
import { registerTurns } from './turns'

// The band above the prompt, its Tool calls panel, the per-turn timer and
// the Remote Control toggle in the prompt footer share one mod.
export const register: Register = (on, options) => {
  registerBand(on, options)
  registerTurns(on, options)
  registerTools(on, options)
  registerRemote(on, options)
  registerOneClick(on, [REMOTE_PANEL, TOOLS_PANEL])
}
