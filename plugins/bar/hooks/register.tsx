import type { Register } from 'claude-code'

import { registerBand } from './band'
import { registerPanels } from './panels'
import { registerTurns } from './turns'

// The band above the prompt, the panels it opens, and the per-turn timer
// share one mod.
export const register: Register = (on, options) => {
  registerBand(on, options)
  registerPanels(on, options)
  registerTurns(on, options)
}
