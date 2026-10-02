import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// The panels a click on the bar opens: the uncommitted changes, and the
// session's subagents. The app's own changes and tasks panels can't be
// opened from a mod, so these stand in for them.

// The Code element draws the diff; past this many characters the rest is cut.
const MAX_DIFF = 60_000

// Bumped by a panel's Refresh button so it reads git again.
const revision = atom({ plugin: 'bar', key: 'revision' } as const, 0)
const agents = atom({ plugin: 'bar', key: 'agents' } as const, 0)

const STATUS_NAMES: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  '??': 'new',
}

const STATUS_COLORS: Record<string, string> = {
  running: 'suggestion',
  completed: 'success',
  failed: 'error',
  killed: 'warning',
}

const git = async ($: EngineInterface, args: string[]) => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args], {
      timeoutMs: 5_000,
    })

    return exitCode === 0 ? stdout : null
  } catch {
    return null
  }
}

export const registerPanels: Register = on => {
  on('ui.render', { component: 'Pane', requestId: 'bar-changes' }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    await read($, revision)
    const status = (await git($, ['status', '--porcelain'])) ?? ''
    const diff =
      (await git($, ['diff', 'HEAD'])) ?? (await git($, ['diff'])) ?? ''
    const files = status
      .split('\n')
      .filter(Boolean)
      .map(line => ({ code: line.slice(0, 2).trim(), path: line.slice(3) }))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Text bold>
            {files.length} changed {files.length === 1 ? 'file' : 'files'}
          </Text>
          <Button
            key="refresh-changes"
            label="Refresh"
            plain
            onPress={() => update($, revision, n => n + 1)}
          />
        </Box>
        {files.map(file => (
          <Text key={file.path}>
            <Text dimColor>{(STATUS_NAMES[file.code[0] ?? ''] ?? STATUS_NAMES[file.code] ?? file.code).padEnd(9)}</Text>
            {file.path}
          </Text>
        ))}
        {diff && (
          <Box marginTop={1}>
            <Code
              format="diff"
              source={diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n… diff cut at ${MAX_DIFF} characters` : diff}
            />
          </Box>
        )}
        {files.length === 0 && <Text dimColor>Nothing uncommitted.</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'bar-agents' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    // Redraws whenever the bar's running count changes.
    await read($, agents)
    const list = [...(await $.agent.list())].reverse()

    return (
      <Box flexDirection="column">
        <Text bold>
          {list.filter(agent => agent.status === 'running').length} running · {list.length} this session
        </Text>
        {list.length === 0 && <Text dimColor>No subagents yet.</Text>}
        {list.map(agent => (
          <Text key={agent.id}>
            <Text color={STATUS_COLORS[agent.status] ?? 'inactive'}>● </Text>
            {agent.description}
            <Text dimColor>
              {'  '}
              {agent.type} · {agent.status}
            </Text>
          </Text>
        ))}
      </Box>
    )
  })
}
