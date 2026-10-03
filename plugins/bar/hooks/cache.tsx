import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheState, CacheTtl, HandoffState } from '../types'

// The prompt cache: how long the conversation so far stays cached, counted
// from the main loop's last model response, and the Hand off button that
// carries the work into a new session before (or after) it lapses.

const TTL_MS: Record<CacheTtl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }
// How much of the transcript's end is read to find the last response.
const TAIL_BYTES = 400_000
// The skill the button runs, from Matt Pocock's skills plugin.
const HANDOFF_SKILL = 'mattpocock-skills:handoff'
// A new session picks up a handoff only this soon after it was written.
const CLAIM_MS = 5 * 60_000
const CLAIM_FILE = '.claude/bar/handoff/pending.json'

const IDLE: HandoffState = { status: 'idle', path: null, clickedAt: null, turnId: null, detail: null }

const cacheAtom = atom({ plugin: 'bar', key: 'cache' } as const, null)
const handoffAtom = atom({ plugin: 'bar', key: 'handoff' } as const, IDLE)
const turnList = atom({ plugin: 'bar', key: 'turns' } as const, [])

let home: string | null = null

const homeDir = async ($: EngineInterface) => {
  home ??= (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout

  return home
}

// Claude Code keeps a session's transcript under its folder's path with
// every other character turned into a dash.
const transcriptPath = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()

  return `${await homeDir($)}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}/${await $.session.id()}.jsonl`
}

type UsageLine = {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
}

// The cache as the transcript has it: when the main loop's last response
// came, and the lifetime its cache writes asked for (a response that only
// read the cache says nothing, so an earlier one decides).
const fromTranscript = async ($: EngineInterface): Promise<CacheState | null> => {
  const path = await transcriptPath($)

  if (!(await $.fs.exists(path))) {
    return null
  }

  const { stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), path])
  const lines = stdout.split('\n').reverse()
  let at: number | null = null
  let ttl: CacheTtl | null = null

  for (const text of lines) {
    if (!text.includes('"assistant"') || !text.includes('"usage"')) {
      continue
    }

    let row: UsageLine
    try {
      row = JSON.parse(text) as UsageLine
    } catch {
      continue
    }

    if (row.type !== 'assistant' || row.isSidechain || !row.message?.usage) {
      continue
    }

    at ??= row.timestamp ? Date.parse(row.timestamp) : null
    const written = row.message.usage.cache_creation
    if ((written?.ephemeral_1h_input_tokens ?? 0) > 0) {
      ttl = '1h'
    } else if ((written?.ephemeral_5m_input_tokens ?? 0) > 0) {
      ttl = '5m'
    }

    if (at !== null && ttl !== null) {
      break
    }
  }

  return at === null ? null : { at, ttl: ttl ?? '5m' }
}

const refresh = async ($: EngineInterface) => {
  const found = await fromTranscript($)

  if (found) {
    await update($, cacheAtom, () => found)
  }
}

// When the cache lapses, in ms; null before the first response.
export const cacheExpiry = (cache: CacheState | null) => (cache ? cache.at + TTL_MS[cache.ttl] : null)

const stamp = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

const continuePrompt = (path: string) =>
  `Continue from the handoff document at ${path}. Read it first, call the skills it suggests, then pick up the work where it left off.`

// Runs the handoff skill, telling it where to save the document; the turn
// hooks below open the new session once that turn ends with the file there.
const startHandoff = async ($: EngineInterface) => {
  const state = await read($, handoffAtom)

  if (state.status === 'writing' || state.status === 'opening') {
    return
  }

  await update($, handoffAtom, (): HandoffState => ({ ...IDLE, status: 'writing' }))

  const commands = await $.command.list()

  if (!commands.some(command => command.name === HANDOFF_SKILL)) {
    await update($, handoffAtom, (): HandoffState => ({ ...IDLE, status: 'error', detail: `/${HANDOFF_SKILL} isn't installed` }))
    $.ui.toast(`Hand off needs /${HANDOFF_SKILL}: install mattpocock-skills@mattpocock`)
    return
  }

  const tmp = (await $.process.run(['sh', '-c', 'printf %s "${TMPDIR:-/tmp}"'])).stdout.replace(/\/$/, '')
  const cwd = await $.session.cwd()
  const folder = cwd.split('/').filter(Boolean).pop() ?? 'session'
  const now = await $.clock.now()
  const path = `${tmp}/claude-handoffs/${folder.replace(/[^a-zA-Z0-9._-]/g, '-')}-${stamp(now)}.md`
  await $.process.run(['mkdir', '-p', `${tmp}/claude-handoffs`])

  await update($, handoffAtom, (): HandoffState => ({ status: 'writing', path, clickedAt: now, turnId: null, detail: null }))

  try {
    await $.command.run({
      command: HANDOFF_SKILL,
      args: `The next session continues this work. Save the handoff document to exactly this path: ${path}`,
    })
  } catch (error) {
    await update($, handoffAtom, (): HandoffState => ({
      ...IDLE,
      status: 'error',
      detail: error instanceof Error ? error.message : 'the handoff skill did not run',
    }))
  }
}

// Opens a new Code session in this folder with the continue prompt in its
// box, and leaves a note so that session's Bar sends the prompt itself.
const openSession = async ($: EngineInterface, path: string) => {
  const cwd = await $.session.cwd()
  const prompt = continuePrompt(path)
  const claim = `${await homeDir($)}/${CLAIM_FILE}`
  await $.process.run(['mkdir', '-p', claim.replace(/\/[^/]+$/, '')])
  await $.fs.write(claim, JSON.stringify({ cwd, path, prompt, at: await $.clock.now() }))

  const url = `claude://code/new?folder=${encodeURIComponent(cwd)}&q=${encodeURIComponent(prompt)}`
  const { exitCode, stderr } = await $.process.run(['open', url])

  if (exitCode !== 0) {
    await update($, handoffAtom, (): HandoffState => ({ ...IDLE, status: 'error', path, detail: stderr.trim() || 'could not open a new session' }))
    return
  }

  await update($, handoffAtom, (): HandoffState => ({ ...IDLE, status: 'opened', path }))
  $.ui.toast('Handoff written; continuing in a new session')
  $.clock.after(15_000, () => void update($, handoffAtom, (state): HandoffState => (state.status === 'opened' ? IDLE : state)))
}

type Claim = { cwd: string; path: string; prompt: string; at: number }

// A session opened by Hand off: take the note (once, so no other session
// does), send the continue prompt, and empty the box the link filled.
const pickUp = async ($: EngineInterface) => {
  const claim = `${await homeDir($)}/${CLAIM_FILE}`

  if (!(await $.fs.exists(claim))) {
    return
  }

  let note: Claim
  try {
    note = JSON.parse(await $.fs.read(claim)) as Claim
  } catch {
    return
  }

  const now = await $.clock.now()

  if (note.cwd !== (await $.session.cwd()) || now - note.at > CLAIM_MS || (await $.session.turns()) > 0) {
    return
  }

  await $.process.run(['rm', '-f', claim])
  await $.prompt.submit({ text: note.prompt, asUser: true })

  // The app fills the box from the link around when the session starts:
  // clear it whenever it still holds the prompt that was just sent.
  for (const delay of [500, 1_500, 3_000, 6_000]) {
    $.clock.after(delay, async () => {
      const box = await $.prompt.read()
      if (box.text.trim() === note.prompt) {
        await $.prompt.fill({ text: '' })
      }
    })
  }
}

let tick: { cancel: () => void } | null = null
// The last finished turn the ticker has handled.
let seenTurn: string | null = null

// The handoff's turn (the turn hooks mark it) has ended: open the new
// session when the document is there.
const afterHandoffTurn = async ($: EngineInterface) => {
  const state = await read($, handoffAtom)
  const turn = (await read($, turnList)).find(t => t.id === state.turnId)

  if (state.status !== 'writing' || !turn || turn.endedAt === null || !state.path) {
    return
  }

  if (turn.isAborted) {
    await update($, handoffAtom, () => IDLE)
  } else if (await $.fs.exists(state.path)) {
    await update($, handoffAtom, (s): HandoffState => ({ ...s, status: 'opening' }))
    await openSession($, state.path)
  } else {
    await update($, handoffAtom, (): HandoffState => ({ ...IDLE, status: 'error', detail: `the handoff wasn't saved to ${state.path}` }))
  }
}

// At session start: the cache as the transcript left it, a redraw a second
// for the countdown between turns (the turn hooks redraw while a turn runs),
// /bar-handoff, and a handoff to pick up.
const begin = async ($: EngineInterface) => {
  await $.command.register({
    name: 'bar-handoff',
    description: 'Write a handoff and continue in a new session (this one stays as it is)',
  })
  await refresh($)
  seenTurn = (await read($, turnList)).findLast(turn => turn.endedAt !== null)?.id ?? null

  tick?.cancel()
  tick = $.clock.every(1000, async () => {
    if ((await read($, handoffAtom)).status === 'requested') {
      void startHandoff($)
    }

    const turns = await read($, turnList)
    const running = turns.some(turn => turn.endedAt === null)
    const lastEnded = turns.findLast(turn => turn.endedAt !== null)

    // A turn ended: the transcript has its responses with their cache
    // lifetime, and it may be the handoff's.
    if (lastEnded && lastEnded.id !== seenTurn) {
      seenTurn = lastEnded.id
      await refresh($)
      await afterHandoffTurn($)
    }

    const expiry = cacheExpiry(await read($, cacheAtom))
    if (!running && expiry !== null && expiry + 2_000 > (await $.clock.now())) {
      $.ui.invalidate('ui.render')
    }
  })

  void pickUp($)
}

export const registerCache: Register = on => {
  // Every session: the desktop app's sessions are SDK-hosted, not
  // interactive, so one hook per kind (the band has the unmatched one).
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const started = await next(e)
    await begin($)

    return started
  })

  on('session.start', { isInteractive: false }, async ($, e, next) => {
    const started = await next(e)
    await begin($)

    return started
  })

  on('command.run', { command: 'bar-handoff' }, async $ => {
    void startHandoff($)

    return { text: 'Writing the handoff; a new session opens with it when it is done.' }
  })
}
