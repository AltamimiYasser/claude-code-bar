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
// plus an estimate of the output still streaming in; and its output tokens
// each second, oldest first, for the sparkline.
export type LiveTurn = { tokens: Tokens; streaming: number; tools: number; rate: number[] }

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

// Where the context meter is full: the auto-compact window (the model's
// window when none is set), the model's own window, or a token count.
export type ContextLimit = 'autoCompact' | 'model' | number

// The window auto-compact measures against, and who set it (`settings` for
// autoCompactWindow, `auto` when it is the model's own window).
export type CompactWindow = { tokens: number; source: string }

// Bar's settings, from ~/.claude/bar/settings.jsonc (hooks/settings.ts
// documents each one).
export type BarSettings = {
  bar: { enabled: boolean; hover: boolean; pillBorders: boolean }
  context: { enabled: boolean; limit: ContextLimit; click: 'usage' | 'none' }
  planLimits: { fiveHour: boolean; weekly: boolean; resetTime: boolean; hoverDetails: boolean; pace: boolean }
  turn: {
    enabled: boolean
    whileWorking: boolean
    lastTurn: boolean
    tokens: boolean
    toolCalls: boolean
    toolCallsPanel: boolean
  }
  answer: { frame: boolean; footer: boolean; footerTokens: boolean }
  spinnerTimer: boolean
  cache: { enabled: boolean; handoff: boolean }
  remote: {
    enabled: boolean
    autoStart: 'never' | 'newProjects' | 'always'
    notifications: boolean
    sessionsButton: boolean
  }
  levels: { yellow: number; orange: number; red: number }
}

// The prompt cache's lifetime, as the API reports the writes.
export type CacheTtl = '5m' | '1h'

// When the main loop's last response came and how long its cache lives.
export type CacheState = { at: number; ttl: CacheTtl }

// The Hand off button: pressed, writing the handoff (in the turn `turnId`),
// opening the new session with it, done, or what went wrong.
export type HandoffState = {
  status: 'idle' | 'requested' | 'writing' | 'opening' | 'opened' | 'error'
  path: string | null
  clickedAt: number | null
  turnId: string | null
  detail: string | null
}

// Remote Control for this session's folder, as the footer shows it.
export type RemoteStatus = 'off' | 'starting' | 'on' | 'error'
export type RemoteState = { status: RemoteStatus; url: string | null; detail: string | null }

// One folder's Remote Control in the Remote sessions panel (or a
// remote-control process Bar did not start, `isExternal`).
export type RemoteInstance = {
  key: string
  cwd: string | null
  name: string
  status: RemoteStatus | 'stopped' | 'stopping'
  url: string | null
  detail: string | null
  pid: number | null
  startedAt: number | null
  stoppedAt: number | null
  isExternal: boolean
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
      // The auto-compact window; null until the first reading.
      compactWindow: CompactWindow | null
      limits: Limit[]
      turns: Turn[]
      // The tool calls of the running turn, or of the last one.
      calls: ToolCallRecord[]
      // Which rows of the Tool calls panel are open, by call id.
      openCalls: string[]
      remote: RemoteState
      remoteAll: RemoteInstance[]
      // The settings file as last read; absent until the first read.
      settings: BarSettings | null
      // The prompt cache's countdown; null before the first response.
      cache: CacheState | null
      handoff: HandoffState
      // The sample /bar-demo shows instead of the live bar; -1 shows the live one.
      demo: number
    }
  }
}
