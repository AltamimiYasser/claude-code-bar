import type { BarSettings } from '../types'

// The settings file, `~/.claude/bar/settings.jsonc`: what each option is,
// its default, and how a file's text becomes BarSettings. Plain functions with
// no `$`, so every module imports them.

export const SETTINGS_FILE = '.claude/bar/settings.jsonc'

export const DEFAULTS: BarSettings = {
  bar: { enabled: true, hover: true, pillBorders: true },
  context: { enabled: true, limit: null, click: 'usage' },
  planLimits: { fiveHour: true, weekly: true, resetTime: true, hoverDetails: true, pace: true },
  turn: {
    enabled: true,
    whileWorking: true,
    lastTurn: true,
    tokens: true,
    toolCalls: true,
    toolCallsPanel: true,
  },
  answer: { frame: true, footer: true, footerTokens: true },
  spinnerTimer: true,
  remote: { enabled: true, autoStart: 'newProjects', notifications: true, sessionsButton: true },
  levels: { yellow: 0.5, orange: 0.75, red: 1 },
}

// Written once, when the file does not exist yet: every option with its
// default and what it does, so the file documents itself.
export const TEMPLATE = `// Bar settings. Changes apply within a few seconds; no restart needed.
// Delete an option (or the whole file) to get its default back; this file is
// written again with every default if it goes missing.
{
  // ── Bar above the prompt ──────────────────────────────────────────────
  "bar": {
    "enabled": true,              // false hides the whole bar (the turn timer, answer frame and Remote toggle keep working)
    "hover": true,                // master switch for every hover effect in the bar: details, underlines, blue borders
    "pillBorders": true           // the light colored outline around each pill
  },

  // ── Context pill ──────────────────────────────────────────────────────
  "context": {
    "enabled": true,
    "limit": null,                // tokens where the meter is full and red. null = the model's own context window.
                                  // A number (e.g. 400000) sets your own limit, capped at the model's window.
                                  // /bar-limit 300k writes this value; /bar-limit off sets it back to null.
    "click": "usage"              // what clicking "Context" does: "usage" (runs /usage) or "none"
  },

  // ── Plan limits (5h and weekly) ───────────────────────────────────────
  "planLimits": {
    "fiveHour": true,             // show the 5h pill
    "weekly": true,               // show the Week pill
    "resetTime": true,            // the "· 21:20" / "· Sat" after the percentage
    "hoverDetails": true,         // exact reset date in line 2 while hovering a pill (needs bar.hover and turn.enabled)
    "pace": true                  // "on pace for ~84%" in those hover details
  },

  // ── Line 2: the turn ──────────────────────────────────────────────────
  "turn": {
    "enabled": true,              // false hides line 2 entirely (and with it the plan-limit hover details)
    "whileWorking": true,         // live "● Working 1m 12s" while Claude works
    "lastTurn": true,             // "Last turn 37s" between turns
    "tokens": true,               // the in / out / cache read / cache write figures
    "toolCalls": true,            // the "9 tool calls" count on the right
    "toolCallsPanel": true        // clicking that count opens the Tool calls panel
  },

  // ── In the conversation ───────────────────────────────────────────────
  "answer": {
    "frame": true,                // the orange frame around each turn's final answer
    "footer": true,               // "Done in 37s · 20:38:33" under the frame
    "footerTokens": true          // the token figures on the right of that footer
  },
  "spinnerTimer": true,           // live time beside the app's "working" indicator

  // ── Remote Control (prompt footer) ────────────────────────────────────
  "remote": {
    "enabled": true,              // show the ○ Remote toggle and the /remote command
    "autoStart": "newProjects",   // "never"
                                  // "newProjects": start it in a project's first session
                                  // "always": start it whenever a session opens and it isn't running
    "notifications": true,        // the "Remote Control on for <project>" notices
    "sessionsButton": true        // the "Remote sessions" button: every folder's Remote Control, to stop or start again
  },

  // ── Colors ────────────────────────────────────────────────────────────
  // The share of a limit where the meters, numbers and borders change color.
  "levels": {
    "yellow": 0.5,
    "orange": 0.75,
    "red": 1.0
  }
}
`

// JSON with comments and trailing commas, as people write it: comments go
// (never inside a string), then commas before a closing bracket.
export const parseJsonc = (text: string): unknown => {
  let out = ''
  let inString = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const nextChar = text[i + 1]

    if (inString) {
      out += char
      if (char === '\\') {
        out += nextChar ?? ''
        i += 1
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && nextChar === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (char === '/' && nextChar === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
    } else {
      out += char
    }
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// Each option from the file when it has the default's type (or is one of a
// choice's words), else the default: a typo never breaks the bar.
const pick = <T,>(value: unknown, fallback: T, choices?: readonly string[]): T => {
  if (choices) {
    return typeof value === 'string' && choices.includes(value) ? (value as T) : fallback
  }
  if (typeof fallback === 'boolean') {
    return (typeof value === 'boolean' ? value : fallback) as T
  }

  return (typeof value === typeof fallback ? value : fallback) as T
}

const level = (value: unknown, fallback: number) =>
  typeof value === 'number' && value > 0 && value <= 10 ? value : fallback

export const toSettings = (raw: unknown): BarSettings => {
  const file = isObject(raw) ? raw : {}
  const section = (name: string) => (isObject(file[name]) ? (file[name] as Record<string, unknown>) : {})
  const bar = section('bar')
  const context = section('context')
  const plan = section('planLimits')
  const turn = section('turn')
  const answer = section('answer')
  const remote = section('remote')
  const levels = section('levels')
  const d = DEFAULTS
  const limit = context.limit

  return {
    bar: {
      enabled: pick(bar.enabled, d.bar.enabled),
      hover: pick(bar.hover, d.bar.hover),
      pillBorders: pick(bar.pillBorders, d.bar.pillBorders),
    },
    context: {
      enabled: pick(context.enabled, d.context.enabled),
      limit: typeof limit === 'number' && limit > 0 ? Math.round(limit) : null,
      click: pick(context.click, d.context.click, ['usage', 'none']),
    },
    planLimits: {
      fiveHour: pick(plan.fiveHour, d.planLimits.fiveHour),
      weekly: pick(plan.weekly, d.planLimits.weekly),
      resetTime: pick(plan.resetTime, d.planLimits.resetTime),
      hoverDetails: pick(plan.hoverDetails, d.planLimits.hoverDetails),
      pace: pick(plan.pace, d.planLimits.pace),
    },
    turn: {
      enabled: pick(turn.enabled, d.turn.enabled),
      whileWorking: pick(turn.whileWorking, d.turn.whileWorking),
      lastTurn: pick(turn.lastTurn, d.turn.lastTurn),
      tokens: pick(turn.tokens, d.turn.tokens),
      toolCalls: pick(turn.toolCalls, d.turn.toolCalls),
      toolCallsPanel: pick(turn.toolCallsPanel, d.turn.toolCallsPanel),
    },
    answer: {
      frame: pick(answer.frame, d.answer.frame),
      footer: pick(answer.footer, d.answer.footer),
      footerTokens: pick(answer.footerTokens, d.answer.footerTokens),
    },
    spinnerTimer: pick(file.spinnerTimer, d.spinnerTimer),
    remote: {
      enabled: pick(remote.enabled, d.remote.enabled),
      autoStart: pick(remote.autoStart, d.remote.autoStart, ['never', 'newProjects', 'always']),
      notifications: pick(remote.notifications, d.remote.notifications),
      sessionsButton: pick(remote.sessionsButton, d.remote.sessionsButton),
    },
    levels: {
      yellow: level(levels.yellow, d.levels.yellow),
      orange: level(levels.orange, d.levels.orange),
      red: level(levels.red, d.levels.red),
    },
  }
}

// The file's text with `context.limit` set to a new value, its comments and
// layout kept: what /bar-limit writes.
export const withLimit = (text: string, limit: number | null) => {
  const value = limit === null ? 'null' : String(limit)
  const pattern = /("limit"\s*:\s*)(null|\d+(?:\.\d+)?)/

  return pattern.test(text) ? text.replace(pattern, `$1${value}`) : null
}
