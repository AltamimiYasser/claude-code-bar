// The context window's fill as the last response reported it.
export type Fill = { tokens: number; window: number }

// The folder the session works in, and its git branch when it is a repo:
// `root` is what a click opens in Finder, `url` the branch on GitHub.
export type Place = {
  folder: string
  root: string
  branch: string | null
  url: string | null
}


// Uncommitted work against HEAD: changed files, added and removed lines.
export type Changes = { files: number; added: number; removed: number }

// A plan usage window (`five_hour`, `seven_day`) as the last response had it.
export type Limit = { kind: string; percent: number; resetsAt: string | null }

// What a turn's requests cost in tokens, summed, as the API bills them.
export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// Everything one drawing of the bar shows.
export type BarData = {
  tokens: number
  limit: number
  place: Place | null
  changes: Changes | null
  limits: Limit[]
  agents: number
}

// One main-loop turn: what started it, when, and how it ended.
export type Turn = {
  id: string
  prompt: string
  startedAt: number
  endedAt: number | null
  answer: string | null
  isAborted: boolean
  tokens: Tokens | null
}

declare module 'claude-code' {
  interface PluginState {
    bar: {
      fill: Fill | null
      place: Place | null
      changes: Changes | null
      limits: Limit[]
      agents: number
      turns: Turn[]
      now: number
      // The sample /bar-demo shows instead of the live bar; -1 shows the live one.
      demo: number
      revision: number
    }
  }
}
