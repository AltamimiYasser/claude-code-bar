import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Turn } from '../types'
import { clockTime, duration, shortCount } from './format'

const KEPT_TURNS = 50
// Markdown draws at most 10,000 characters; a longer answer keeps the
// engine's own drawing.
const MAX_FRAMED = 9_500
// The one colour the timer lines use, on the value worth a glance; the rest
// is dim, like the app's own metadata rows.
const ACCENT = 'suggestion'

const turns = atom({ plugin: 'bar', key: 'turns' } as const, [])
// Ticks once a second while a turn runs; only running rows read it.
const now = atom({ plugin: 'bar', key: 'now' } as const, 0)

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

// The latest turn a prompt row started.
const turnForPrompt = (list: Turn[], text: string) => {
  const wanted = normalize(text)

  return wanted
    ? list.findLast(turn => normalize(turn.prompt) === wanted)
    : undefined
}

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
    }
    await update($, now, () => startedAt)
    await update($, turns, list => [...list, turn].slice(-KEPT_TURNS))

    tick?.cancel()
    tick = $.clock.every(1000, async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
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
            ? { ...turn, endedAt, answer: e.answer, isAborted: e.isAborted, tokens }
            : turn,
        ),
      )
    }

    return next(e)
  })

  // The top of the agent's turn, under the prompt: when it started, and a
  // live count until it ends, then the start, end and total.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const turn = turnForPrompt(await read($, turns), e.props.text)
    const drawn = await next(e)

    if (!turn) {
      return drawn
    }

    const { Box, Text } = $.ui.resolve(e)
    const isRunning = turn.endedAt === null
    const took = (isRunning ? await read($, now) : (turn.endedAt ?? 0)) - turn.startedAt

    return (
      <Box flexDirection="column">
        {drawn}
        <Box marginTop={1}>
          <Text dimColor>{clockTime(turn.startedAt)}</Text>
          {isRunning ? (
            <Text color={ACCENT}>{'  ·  '}Working {duration(took)}</Text>
          ) : (
            <Text dimColor>
              {' – '}
              {clockTime(turn.endedAt ?? 0)}
              {'  ·  '}
              <Text color={ACCENT}>{duration(took)}</Text>
            </Text>
          )}
        </Box>
      </Box>
    )
  })

  // While the turn runs, the same live count beside the spinner.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const running = (await read($, turns)).findLast(turn => turn.endedAt === null)

    if (!running) {
      return next(e)
    }

    const at = await read($, now)

    return next({
      ...e,
      props: { ...e.props, suffix: `… ${duration(at - running.startedAt)}` },
    })
  })

  // The final answer, framed apart from the work before it; the turn's end
  // line sits under the frame, closing the turn.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const turn = turnForAnswer(await read($, turns), e.props.text)

    if (!turn || turn.endedAt === null || e.props.text.length > MAX_FRAMED) {
      return next(e)
    }

    const { Box, Text, Markdown } = $.ui.resolve(e)

    const { tokens } = turn

    return (
      <Box flexDirection="column" marginTop={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
          paddingX={1}
        >
          <Text color="claude">✻ Answer</Text>
          <Markdown text={e.props.text} />
        </Box>
        <Box marginTop={1} paddingX={1} flexDirection="row" justifyContent="space-between">
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
          {tokens && (
            <Text dimColor>
              {shortCount(tokens.input)} in{'  ·  '}
              {shortCount(tokens.output)} out{'  ·  '}
              {shortCount(tokens.cacheRead)} cache read{'  ·  '}
              {shortCount(tokens.cacheWrite)} cache write
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
