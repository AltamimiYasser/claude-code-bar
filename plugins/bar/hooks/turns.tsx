import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LiveTurn, ToolCallRecord, Tokens, Turn } from '../types'
import { clockTime, duration, shortCount } from './format'
import { DEFAULTS } from './settings'

const KEPT_TURNS = 50
// Markdown draws at most 10,000 characters; a longer answer keeps the
// engine's own drawing.
const MAX_FRAMED = 9_500
// The one colour the timer lines use, on the value worth a glance; the rest
// is dim, like the app's own metadata rows.
const ACCENT = 'suggestion'

const turns = atom({ plugin: 'bar', key: 'turns' } as const, [])
const calls = atom({ plugin: 'bar', key: 'calls' } as const, [])
const settingsAtom = atom({ plugin: 'bar', key: 'settings' } as const, null)
const openCalls = atom({ plugin: 'bar', key: 'openCalls' } as const, [])
// The prompt cache and the Hand off button (hooks/cache.tsx): each response
// restarts the cache's countdown, and the first turn after a Hand off click
// is the one writing the handoff.
const cacheAtom = atom({ plugin: 'bar', key: 'cache' } as const, null)
const handoffAtom = atom({
  plugin: 'bar',
  key: 'handoff',
} as const, { status: 'idle', path: null, clickedAt: null, turnId: null, detail: null })

// What the Tool calls panel keeps of each input and output.
const MAX_DETAIL = 4_000
// The keys tool.call adds beside a tool's own arguments.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'origin'])

const clip = (text: string) =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n… cut at ${MAX_DETAIL} characters` : text

// The line a call shows in the list: the argument that says the most about
// it (a command, a path, a pattern), on one line.
const summarize = (args: Record<string, unknown>) => {
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim().slice(0, 160)
    }
  }

  return ''
}

// About four characters to a token: enough for a count that moves while a
// response streams, replaced by the exact figure when the request ends.
const CHARS_PER_TOKEN = 4

const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

// The running turn's tally, kept here; the bar reads it when it redraws, so
// a fast stream does not redraw the bar on every piece.
let tally = noTokens()
let streamingChars = 0
let toolCalls = 0
// Output tokens each second of the running turn, for the bar's sparkline:
// the newest last, at most `RATE_SAMPLES` of them.
const RATE_SAMPLES = 24
let rate: number[] = []
let lastOutput = 0

const outputSoFar = () => tally.output + Math.round(streamingChars / CHARS_PER_TOKEN)

// One sample a second. A finished request swaps its estimate for the exact
// count, which can land a little under it: never a negative rate.
const sampleRate = () => {
  const output = outputSoFar()
  rate = [...rate, Math.max(0, output - lastOutput)].slice(-RATE_SAMPLES)
  lastOutput = output
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

// The finished turn whose final answer is (or ends with) this text block.
const turnForAnswer = (list: Turn[], text: string) => {
  const block = normalize(text)

  return block
    ? list.findLast(
        turn =>
          turn.answer !== null &&
          turn.endedAt !== null &&
          normalize(turn.answer).endsWith(block),
      )
    : undefined
}



let tick: { cancel: () => void } | null = null

// The running turn's tally as the bar draws it: read straight from this
// module when the bar redraws, so nothing is written each second.
export const liveSnapshot = (): LiveTurn => ({
  tokens: { ...tally },
  streaming: Math.round(streamingChars / CHARS_PER_TOKEN),
  tools: toolCalls,
  rate: [...rate],
})

export const registerTurns: Register = on => {
  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const turn: Turn = {
      id: e.turnId,
      prompt: e.text,
      startedAt,
      endedAt: null,
      answer: null,
      isAborted: false,
      tokens: null,
      tools: 0,
    }
    await update($, turns, list => [...list, turn].slice(-KEPT_TURNS))

    await update($, handoffAtom, state =>
      state.status === 'writing' && state.turnId === null ? { ...state, turnId: e.turnId } : state,
    )

    tally = noTokens()
    streamingChars = 0
    toolCalls = 0
    rate = []
    lastOutput = 0
    await update($, calls, () => [])
    await update($, openCalls, () => [])

    tick?.cancel()
    // A redraw a second while the turn runs, and nothing else: the bar and
    // the spinner read the clock and the tally themselves when they draw.
    // (Writing them to state instead made every tick wait for a redraw to
    // land, a second or more on the desktop, so ticks were skipped and the
    // timer moved in 2-second steps.)
    tick = $.clock.every(1000, () => {
      sampleRate()
      $.ui.invalidate('ui.render')
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Subagents finish turns too; only the main loop's ends the timer.
    if (e.agentId === undefined) {
      tick?.cancel()
      tick = null
      const endedAt = await $.clock.now()
      const tokens = e.usage
        ? {
            input: e.usage.input_tokens,
            output: e.usage.output_tokens,
            cacheRead: e.usage.cache_read_input_tokens,
            cacheWrite: e.usage.cache_creation_input_tokens,
          }
        : null
      await update($, turns, list =>
        list.map(turn =>
          turn.id === e.turnId
            ? { ...turn, endedAt, answer: e.answer, isAborted: e.isAborted, tokens, tools: toolCalls }
            : turn,
        ),
      )
    }

    return next(e)
  })

  // Counts the main loop's tool calls (a subagent's are its own)
  // and records each one for the Tool calls panel.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    toolCalls += 1
    const args = Object.fromEntries(Object.entries(e).filter(([key]) => !ENVELOPE.has(key)))
    const startedAt = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${startedAt}`
    const record: ToolCallRecord = {
      id,
      tool: e.tool,
      summary: summarize(args),
      input: clip(JSON.stringify(args, null, 2)),
      output: null,
      status: 'running',
      startedAt,
      ms: null,
    }
    await update($, calls, list => [...list, record])

    const result = await next(e)
    const ms = (await $.clock.now()) - startedAt
    const finished: ToolCallRecord =
      'deny' in result && result.deny
        ? { ...record, status: 'denied', output: result.deny, ms }
        : {
            ...record,
            status: result.isError ? 'error' : 'done',
            output: clip(result.text ?? JSON.stringify(result.result ?? null, null, 2)),
            ms,
          }
    await update($, calls, list => list.map(call => (call.id === id ? finished : call)))

    return result
  })

  // Each model request of the main loop: its streamed pieces feed the
  // estimate, and its stop brings the exact usage. Passes every chunk on.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    if (e.agentId !== undefined) {
      return yield* stream
    }

    let step = await stream.next()

    while (!step.done) {
      const chunk = step.value

      if (chunk.kind === 'text' || chunk.kind === 'thinking') {
        streamingChars += chunk.text.length
      } else if (chunk.kind === 'input') {
        streamingChars += chunk.json.length
      } else if (chunk.kind === 'stop') {
        streamingChars = 0
        const at = await $.clock.now()
        await update($, cacheAtom, cache => ({ at, ttl: cache?.ttl ?? '5m' }))
        if (chunk.usage) {
          tally = {
            input: tally.input + chunk.usage.input_tokens,
            output: tally.output + chunk.usage.output_tokens,
            cacheRead: tally.cacheRead + chunk.usage.cache_read_input_tokens,
            cacheWrite: tally.cacheWrite + chunk.usage.cache_creation_input_tokens,
          }
        }
      }

      yield chunk
      step = await stream.next()
    }

    return step.value
  })

  // While the turn runs, the same live count beside the spinner.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const running = (await read($, turns)).findLast(turn => turn.endedAt === null)
    const { spinnerTimer } = (await read($, settingsAtom)) ?? DEFAULTS

    if (!running || !spinnerTimer) {
      return next(e)
    }

    const at = await $.clock.now()

    return next({
      ...e,
      props: { ...e.props, suffix: `… ${duration(at - running.startedAt)}` },
    })
  })

  // The final answer, framed apart from the work before it; the turn's end
  // line sits under the frame, closing the turn. Each part is a setting
  // (`answer`): without the frame the answer draws plain, footer and all.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { answer } = (await read($, settingsAtom)) ?? DEFAULTS

    if (!answer.frame && !answer.footer) {
      return next(e)
    }

    const turn = turnForAnswer(await read($, turns), e.props.text)

    if (!turn || turn.endedAt === null || e.props.text.length > MAX_FRAMED) {
      return next(e)
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)

    const { tokens } = turn

    return (
      <Box flexDirection="column" marginTop={1}>
        {answer.frame ? (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor="claude"
            paddingX={1}
          >
            <Text color="claude">✻ Answer</Text>
            <Markdown text={e.props.text} />
          </Box>
        ) : (
          <Markdown text={e.props.text} />
        )}
        {answer.footer && (
          <Box marginTop={1} paddingX={answer.frame ? 1 : 0} flexDirection="row" justifyContent="space-between">
            <Text dimColor>
              {turn.isAborted ? (
                <Text color="warning">Interrupted after {duration(turn.endedAt - turn.startedAt)}</Text>
              ) : (
                <Text>
                  Done in <Text color={ACCENT}>{duration(turn.endedAt - turn.startedAt)}</Text>
                </Text>
              )}
              {'  ·  '}
              {clockTime(turn.endedAt)}
            </Text>
            {answer.footerTokens && tokens && (
              <Text dimColor>
                {shortCount(tokens.input)} in{'  ·  '}
                {shortCount(tokens.output)} out{'  ·  '}
                {shortCount(tokens.cacheRead)} cache read{'  ·  '}
                {shortCount(tokens.cacheWrite)} cache write
              </Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
