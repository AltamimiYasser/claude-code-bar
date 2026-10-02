import type { Register } from 'claude-code'

import { registerBand } from './band'
import { registerTools } from './tools'
import { registerTurns } from './turns'

// The band above the prompt, its Tool calls panel and the per-turn timer
// share one mod.
export const register: Register = (on, options) => {
  registerBand(on, options)
  registerTurns(on, options)
  registerTools(on, options)
}
