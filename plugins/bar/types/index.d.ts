// The context window's fill as the last response reported it.
export type Fill = { tokens: number; window: number }

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
  limits: Limit[]
}

// The running turn's tokens so far: exact for each finished model request,
// plus an estimate of the output still streaming in.
export type LiveTurn = { tokens: Tokens; streaming: number; tools: number }

// One tool call of the main loop, for the Tool calls panel: what it was,
// a one-line summary, and its input and output cut to a readable length.
export type ToolCallRecord = {
  id: string
  tool: string
  summary: string
  input: string
  output: string | null
  status: 'running' | 'done' | 'error' | 'denied'
  startedAt: number
  ms: number | null
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
  // How many tools the main loop called in the turn.
  tools: number
}

declare module 'claude-code' {
  interface PluginState {
    bar: {
      fill: Fill | null
      limits: Limit[]
      turns: Turn[]
      now: number
      live: LiveTurn | null
      // The tool calls of the running turn, or of the last one.
      calls: ToolCallRecord[]
      // Which rows of the Tool calls panel are open, by call id.
      openCalls: string[]
      // The sample /bar-demo shows instead of the live bar; -1 shows the live one.
      demo: number
    }
  }
}
