import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BarSettings, RemoteInstance, RemoteState, RemoteStatus } from '../types'
import { clockTime, duration, longDate } from './format'
import { oneClick } from './one-click'
import { DEFAULTS, parseJsonc, SETTINGS_FILE, toSettings } from './settings'

// Remote Control in the prompt footer: a toggle for this session's folder,
// a "Remote sessions" button that lists every folder's instance (running or
// not) with Stop / Start / Remove, and `/remote`. One instance per folder,
// shared by every session in it: the process runs detached, so it outlives
// the session that started it, and a record per folder in
// ~/.claude/bar/remote (its folder, pid and log) lets every session see it,
// follow it, stop it and start it again.

// This session's folder, as the footer toggle shows it.
const remote = atom({ plugin: 'bar', key: 'remote' } as const, {
  status: 'off',
  url: null,
  detail: null,
})
// Every folder's instance, and those started outside Bar, for the panel.
const remoteAll = atom({ plugin: 'bar', key: 'remoteAll' } as const, [])
const settingsAtom = atom({ plugin: 'bar', key: 'settings' } as const, null)

export const PANEL = 'bar-remote'
const POLL_MS = 2_000
// How often the panel's "running 4m 12s" moves while it is shown.
const TICK_MS = 1_000
// How much of the log a check reads: the output redraws one block over and
// over, so its end holds the current state.
const TAIL_BYTES = 4_000
// remote-control redraws its status block over and over, so its log grows
// without end; past this size a check empties it (the process appends, so it
// carries on at the start), and the next redraw fills it again.
const MAX_LOG_BYTES = 512_000
const URL_PATTERN = /https:\/\/claude\.ai\/code\?environment=[\w-]+/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

// A folder's place in ~/.claude/bar/remote: its record and its log.
type Folder = { key: string; cwd: string; name: string; record: string; log: string }

// What a folder's record file holds. `pid` is null once stopped; the record
// stays so the folder can be started again from the panel. Records written
// by Bar 1.2's first build lack cwd and name.
type RemoteRecord = {
  cwd?: string
  name?: string
  pid: number | null
  log: string
  startedAt: number | null
  stoppedAt?: number | null
  // The pid a Stop ended: remote-control takes seconds to exit, and until it
  // has, the folder shows "stopping…" rather than the process showing up as
  // one started outside Bar.
  stoppedPid?: number | null
}

// How long a stopped remote-control gets to exit before it is killed outright.
const STOP_GRACE_MS = 15_000



let home: string | null = null
// This session's folder; set at session start.
let own: Folder | null = null
// The status this session last showed, to toast only on a change.
let shown: RemoteStatus = 'off'

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const clean = (text: string) => text.replace(ANSI, '').replace(/\r/g, '\n')

const lastLine = (text: string) =>
  clean(text)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .pop() ?? null

const recordsFolder = () => `${home ?? ''}/.claude/bar/remote`

// One record per folder, named after its path.
const folderOf = (cwd: string, name = basename(cwd)): Folder => {
  const key = cwd.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')

  return {
    key,
    cwd,
    name,
    record: `${recordsFolder()}/${key}.json`,
    log: `${recordsFolder()}/${key}.log`,
  }
}

async function locate($: EngineInterface) {
  home = (await $.process.run(['sh', '-c', 'printf %s "$HOME"'])).stdout
  own = folderOf(await $.session.cwd())
}

async function readRecord($: EngineInterface, path: string): Promise<RemoteRecord | null> {
  try {
    return JSON.parse(await $.fs.read(path)) as RemoteRecord
  } catch {
    return null
  }
}

// The settings as the band last read them; at session start, before the
// band's first read may have landed, straight from the file.
async function settingsOf($: EngineInterface): Promise<BarSettings> {
  const loaded = await read($, settingsAtom)

  if (loaded) {
    return loaded
  }

  try {
    return toSettings(parseJsonc(await $.fs.read(`${home ?? ''}/${SETTINGS_FILE}`)))
  } catch {
    return DEFAULTS
  }
}

// This session's folder, as the footer shows it, with a notice on a change.
async function show($: EngineInterface, next: RemoteState) {
  const current = await read($, remote)

  if (JSON.stringify(current) !== JSON.stringify(next)) {
    await update($, remote, () => next)
  }

  if (next.status !== shown && (await settingsOf($)).remote.notifications) {
    if (next.status === 'on' && own) {
      $.ui.toast(`Remote Control on for ${own.name}`)
    } else if (next.status === 'error' && shown !== 'off') {
      $.ui.toast(`Remote Control stopped: ${next.detail ?? 'the process exited'}`)
    }
  }
  shown = next.status
}

// The running remote-control processes, by pid, from one `ps`.
async function runningProcesses($: EngineInterface) {
  const { stdout } = await $.process.run(['ps', '-A', '-o', 'pid=,command='])
  const found = new Map<number, string>()

  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match?.[1] && match[2]?.includes('claude remote-control')) {
      found.set(Number(match[1]), match[2])
    }
  }

  return found
}

// Reads every folder's record and the process behind it: the panel's list,
// and this session's own state. Every session runs it, so all of them agree.
async function poll($: EngineInterface) {
  if (!own) {
    await locate($)
  }

  const processes = await runningProcesses($)
  const folder = recordsFolder()
  const entries = (await $.fs.exists(folder)) ? await $.fs.list(folder) : []
  const instances: RemoteInstance[] = []
  const known = new Set<number>()

  for (const entry of entries.filter(item => item.name.endsWith('.json'))) {
    const key = entry.name.slice(0, -'.json'.length)
    const record = await readRecord($, `${folder}/${entry.name}`)

    if (!record) {
      continue
    }

    // A record from before cwd was kept: this session's own folder fills it in.
    const cwd = record.cwd ?? (own && key === own.key ? own.cwd : null)
    const name = record.name ?? (cwd ? basename(cwd) : (key.split('_').pop() ?? key))
    const isAlive = record.pid !== null && processes.has(record.pid)
    let status: RemoteInstance['status'] = record.pid === null ? 'stopped' : 'error'
    let url: string | null = null
    let detail: string | null = null

    // A stopped one still exiting: shown as stopping, not as a stray process;
    // past the grace period it is killed outright.
    if (record.pid === null && record.stoppedPid && processes.has(record.stoppedPid)) {
      known.add(record.stoppedPid)
      status = 'stopping'
      if (record.stoppedAt && (await $.clock.now()) - record.stoppedAt > STOP_GRACE_MS) {
        await $.process.run(['kill', '-9', String(record.stoppedPid)])
      }
    }

    if (record.pid !== null) {
      known.add(record.pid)
      const { stdout } = await $.process.run(['tail', '-c', String(TAIL_BYTES), record.log])
      const output = clean(stdout)

      if (isAlive) {
        // "Connecting" arrives first; only "Connected" means it is up.
        status = output.includes('Connected') ? 'on' : 'starting'
        url = output.match(URL_PATTERN)?.[0] ?? null
        if ((await $.fs.stat(record.log)).size > MAX_LOG_BYTES) {
          await $.fs.write(record.log, '')
        }
      } else {
        detail = lastLine(stdout)
      }
    }

    instances.push({
      key,
      cwd,
      name,
      status,
      url,
      detail,
      pid: isAlive ? record.pid : null,
      startedAt: record.startedAt,
      stoppedAt: record.stoppedAt ?? null,
      isExternal: false,
    })
  }

  // remote-control processes Bar did not start: listed, and stoppable.
  for (const [pid, command] of processes) {
    if (!known.has(pid)) {
      const name = /--name\s+(\S+)/.exec(command)?.[1] ?? 'remote-control'
      instances.push({
        key: `pid-${pid}`,
        cwd: null,
        name,
        status: 'on',
        url: null,
        detail: null,
        pid,
        startedAt: null,
        stoppedAt: null,
        isExternal: true,
      })
    }
  }

  // Running first, then the most recently used.
  const order = { on: 0, starting: 1, stopping: 2, error: 3, stopped: 4, off: 5 }
  instances.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (b.stoppedAt ?? b.startedAt ?? 0) - (a.stoppedAt ?? a.startedAt ?? 0),
  )

  if (JSON.stringify(await read($, remoteAll)) !== JSON.stringify(instances)) {
    await update($, remoteAll, () => instances)
  }
  const mine = own ? instances.find(instance => instance.key === own?.key) : undefined
  await show(
    $,
    !mine || mine.status === 'stopped' || mine.status === 'stopping' || mine.status === 'off'
      ? { status: 'off', url: null, detail: null }
      : { status: mine.status, url: mine.url, detail: mine.detail },
  )
}

async function startFolder($: EngineInterface, target: Folder) {
  // Detached so it outlives this session: in the background, stdin closed,
  // its log opened for appending (so emptying it later is safe),
  // hung-up signals ignored, and in a process session of its own (perl's
  // setsid, which macOS lacks as a command), so nothing that cleans up this
  // shell's group reaches it. exec keeps one pid all the way to claude, the
  // pid the shell prints. The app's PATH may lack Homebrew's and the usual
  // install folders, so they are added.
  const { stdout } = await $.process.run([
    'sh',
    '-c',
    [
      'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.claude/local"',
      'mkdir -p "$1" && cd "$2" || exit 1',
      ': >"$4"',
      'nohup perl -MPOSIX -e \'POSIX::setsid(); exec @ARGV\' claude remote-control --name "$3" >>"$4" 2>&1 </dev/null &',
      'echo $!',
    ].join('\n'),
    'sh',
    recordsFolder(),
    target.cwd,
    target.name,
    target.log,
  ])
  const pid = Number(stdout.trim())
  const record: RemoteRecord = {
    cwd: target.cwd,
    name: target.name,
    pid: pid || null,
    log: target.log,
    startedAt: await $.clock.now(),
    stoppedAt: null,
  }

  await $.fs.write(target.record, JSON.stringify(record))
  await poll($)
}

// Ends the process and marks the record stopped; the record stays, so the
// folder can be started again from the panel.
async function stopInstance($: EngineInterface, instance: RemoteInstance) {
  if (instance.pid !== null) {
    await $.process.run(['kill', String(instance.pid)])
  }

  if (!instance.isExternal) {
    const path = `${recordsFolder()}/${instance.key}.json`
    const record = await readRecord($, path)
    if (record) {
      await $.fs.write(
        path,
        JSON.stringify({ ...record, pid: null, stoppedPid: instance.pid, stoppedAt: await $.clock.now() }),
      )
    }
  }

  await poll($)
}

// Takes a stopped folder off the list: its record and log go.
async function forgetInstance($: EngineInterface, instance: RemoteInstance) {
  await $.process.run(['rm', '-f', `${recordsFolder()}/${instance.key}.json`, `${recordsFolder()}/${instance.key}.log`])
  await poll($)
}

async function startInstance($: EngineInterface, instance: RemoteInstance) {
  if (instance.cwd) {
    await startFolder($, folderOf(instance.cwd, instance.name))
  }
}

async function stopAll($: EngineInterface) {
  for (const instance of await read($, remoteAll)) {
    if (instance.pid !== null) {
      await stopInstance($, instance)
    }
  }
}

// Off or failed starts this folder's; starting or on stops it. Shows the new
// state at once, before the process has done anything, so a click is never
// silent.
async function toggle($: EngineInterface) {
  await poll($)
  const { status } = await read($, remote)
  const { remote: options } = await settingsOf($)
  const mine = (await read($, remoteAll)).find(instance => instance.key === own?.key)

  if ((status === 'on' || status === 'starting') && mine) {
    if (options.notifications) {
      $.ui.toast('Stopping Remote Control')
    }
    await stopInstance($, mine)
  } else if (own) {
    await show($, { status: 'starting', url: null, detail: null })
    if (options.notifications) {
      $.ui.toast(`Starting Remote Control for ${own.name}`)
    }
    await startFolder($, own)
  }
}

// Sets this session up: where its folder's record lives, `/remote`, and the
// check every 2 seconds that keeps it in step with the other sessions.
async function begin($: EngineInterface, isInteractive: boolean) {
  await locate($)
  shown = 'off'
  await $.command.register({
    name: 'remote',
    description: 'Remote Control for this folder: on or off; "list" shows every folder, "stop-all" stops them',
  })
  // A record from another session (or an earlier run) is picked up here.
  await poll($)
  await autoStart($, isInteractive)
  $.clock.every(POLL_MS, () => void poll($))
  $.clock.every(TICK_MS, () => void tick($))
}

// A redraw a second while the panel is shown and something in it runs, so its
// running times move second by second; a stopped one shows fixed times and
// needs none.
async function tick($: EngineInterface) {
  const isShown = (await $.ui.panes()).some(pane => pane.id === PANEL && pane.isShown)

  if (isShown && (await read($, remoteAll)).some(instance => instance.pid !== null && instance.startedAt)) {
    $.ui.invalidate('ui.render')
  }
}

// When a folder's Remote Control stopped, fixed: `at 22:31` today, the full
// date before, and how long it ran when its start is known.
const stoppedLine = (instance: RemoteInstance, now: number) => {
  const at = instance.stoppedAt ?? 0
  const isToday = new Date(at).toDateString() === new Date(now).toDateString()
  const ran = instance.startedAt && instance.startedAt <= at ? ` · ran ${duration(at - instance.startedAt)}` : ''

  return `stopped ${isToday ? `at ${clockTime(at, false)}` : longDate(at)}${ran}`
}

// Whether this folder has had a session before this one: Claude Code keeps
// one `<session id>.jsonl` per session under ~/.claude/projects/<folder>,
// the folder's path with every other character turned into "-".
async function isNewProject($: EngineInterface) {
  if (!own) {
    return false
  }

  const folder = `${home ?? ''}/.claude/projects/${own.cwd.replace(/[^A-Za-z0-9-]/g, '-')}`

  if (!(await $.fs.exists(folder))) {
    return true
  }

  const mine = `${await $.session.id()}.jsonl`
  const others = (await $.fs.list(folder)).filter(entry => entry.name.endsWith('.jsonl') && entry.name !== mine)

  return others.length === 0
}

// Starts Remote Control on its own, as `remote.autoStart` says: in a
// project's first session, or in any session while it isn't running. Never
// over a failure, so a broken setup doesn't retry on every session. Only in
// a session a person works in: the terminal's, or the desktop app's (which
// reports itself as SDK-hosted, so it is told apart by its entrypoint); a
// one-off `claude -p` run never starts one.
async function autoStart($: EngineInterface, isInteractive: boolean) {
  const { remote: options } = await settingsOf($)
  const { status } = await read($, remote)
  const isPersonal = isInteractive || (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'

  if (!isPersonal || !options.enabled || options.autoStart === 'never' || status !== 'off') {
    return
  }

  if (options.autoStart === 'always' || (await isNewProject($))) {
    await toggle($)
  }
}

// The footer's marks: emoji, which keep their colour inside a button's label.
const FOOTER_MARKS: Record<RemoteStatus, string> = {
  off: '○',
  starting: '🟡',
  on: '🟢',
  error: '🔴',
}

// The panel's marks and state words, in the theme's colours.
const LOOKS: Record<RemoteInstance['status'], { mark: string; color: string; word: string | null }> = {
  off: { mark: '○', color: 'inactive', word: null },
  stopped: { mark: '○', color: 'inactive', word: 'stopped' },
  stopping: { mark: '◌', color: 'inactive', word: 'stopping…' },
  starting: { mark: '◐', color: 'warning', word: 'starting…' },
  on: { mark: '●', color: 'success', word: 'on' },
  error: { mark: '✕', color: 'error', word: 'failed' },
}

export const registerRemote: Register = on => {
  // Every session: the desktop app's sessions are SDK-hosted, not
  // interactive, so one hook per kind (a mod takes one unmatched
  // session.start, and the band has it).
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    await begin($, true)

    return next(e)
  })

  on('session.start', { isInteractive: false }, async ($, e, next) => {
    await begin($, false)

    return next(e)
  })

  on('command.run', { command: 'remote' }, async ($, e) => {
    if (!(await settingsOf($)).remote.enabled) {
      return { text: 'Remote Control is turned off in Bar settings (remote.enabled).' }
    }

    const word = e.args.trim().toLowerCase()

    if (word === 'list') {
      await poll($)
      await $.ui.open({ id: PANEL, title: 'Remote sessions', focus: true })
      return { text: 'Opened Remote sessions.' }
    }

    if (word === 'stop-all') {
      await stopAll($)
      return { text: 'Stopped every Remote Control.' }
    }

    await toggle($)
    const { status } = await read($, remote)

    return {
      text:
        status === 'off'
          ? 'Remote Control is off.'
          : 'Starting Remote Control for this folder. The footer turns green once it connects.',
    }
  })

  // The footer's right side: the app's own mode labels, then Sessions and the
  // Remote toggle. The slot is narrow and clips, so it holds nothing more: a
  // failure message is in the Remote sessions panel, where there is room.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const s = await settingsOf($)

    if (!s.remote.enabled) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const state = await read($, remote)
    const hover = (scope: string) => (s.bar.hover ? { hover: { scope, underline: true, dimColor: false } } : {})

    return (
      <Box key="remote-footer" flexDirection="row" columnGap={1}>
        {e.props.modes.length > 0 && <Text dimColor>{e.props.modes.join(' & ')}</Text>}
        {s.remote.sessionsButton && (
          <Button
            key="remote-sessions"
            label="Sessions"
            plain
            dimColor
            {...hover('bar-remote-sessions')}
            onPress={async () => {
              await poll($)
              await $.ui.open({ id: PANEL, title: 'Remote sessions', focus: true })
            }}
          />
        )}
        {/* One button, mark and all, so the whole of it toggles. A label
            can't take a colour, but an emoji keeps its own: the mark is one
            while it means something, and a plain circle while off. */}
        <Button
          key="remote-toggle"
          label={`${FOOTER_MARKS[state.status]} ${state.status === 'starting' ? 'Remote…' : 'Remote'}`}
          plain
          dimColor={state.status === 'off'}
          {...hover('bar-remote')}
          onPress={() => toggle($)}
        />
      </Box>
    )
  })

  // Every folder's Remote Control: running ones first, each with what it can
  // do now (Stop while running, nothing while stopping, Start and Remove once
// stopped).
  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = await settingsOf($)
    const list = await read($, remoteAll)
    const now = await $.clock.now()
    const running = list.filter(instance => instance.pid !== null)
    const bind = oneClick(PANEL)

    const action = (key: string, label: string, onPress: () => unknown) => (
      <Button
        key={key}
        label={label}
        plain
        {...(s.bar.hover ? { hover: { scope: `bar-${key}`.slice(0, 64), underline: true } } : {})}
        onPress={bind(key, onPress)}
      />
    )

    if (list.length === 0) {
      return <Text dimColor>No Remote Control yet. Turn it on with the Remote toggle in the footer.</Text>
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={3} marginBottom={1}>
          <Text>
            <Text bold>{running.length}</Text>
            <Text dimColor> running · {list.length} in all</Text>
          </Text>
          {running.length > 1 && action('remote-stop-all', 'Stop all', () => stopAll($))}
        </Box>
        {list.map(instance => {
          const look = LOOKS[instance.status]
          const isOwn = instance.key === own?.key
          const since =
            instance.pid !== null && instance.startedAt
              ? `running ${duration(now - instance.startedAt)}`
              : instance.stoppedAt
                ? stoppedLine(instance, now)
                : instance.isExternal
                  ? 'started outside Bar'
                  : ''

          return (
            <Box key={instance.key} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" columnGap={1}>
                <Text color={look.color}>{look.mark}</Text>
                <Text bold>{instance.name}</Text>
                {isOwn && <Text dimColor>(this folder)</Text>}
                {look.word && <Text color={look.color}>{look.word}</Text>}
                <Box flexGrow={1} />
                {instance.pid !== null && action(`remote-stop-${instance.key}`, 'Stop', () => stopInstance($, instance))}
                {instance.status === 'stopped' &&
                  instance.cwd &&
                  action(`remote-start-${instance.key}`, 'Start', () => startInstance($, instance))}
                {instance.status === 'stopped' &&
                  !instance.isExternal &&
                  action(`remote-forget-${instance.key}`, 'Remove', () => forgetInstance($, instance))}
              </Box>
              <Text dimColor wrap="truncate-start">
                {[instance.cwd ?? (instance.isExternal ? `pid ${instance.pid}` : ''), since]
                  .filter(Boolean)
                  .join('  ·  ')}
              </Text>
              {instance.status === 'error' && instance.detail && (
                <Text color="error" dimColor wrap="truncate-end">
                  {instance.detail}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
