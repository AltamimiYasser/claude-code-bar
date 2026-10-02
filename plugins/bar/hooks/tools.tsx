import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ToolCallRecord } from '../types'
import { clockTime, duration } from './format'
import { oneClick } from './one-click'

// The Tool calls panel, opened from the count on the bar: one line per call
// of the running (or last) turn, each opening to its input and output.

const calls = atom({ plugin: 'bar', key: 'calls' } as const, [])
const openCalls = atom({ plugin: 'bar', key: 'openCalls' } as const, [])

export const TOOLS_PANEL = 'bar-tools'

const STATUS_COLORS: Record<ToolCallRecord['status'], string> = {
  running: 'suggestion',
  done: 'success',
  error: 'error',
  denied: 'warning',
}

export const registerTools: Register = on => {
  on('ui.render', { component: 'Pane', requestId: TOOLS_PANEL }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, calls)
    const open = new Set(await read($, openCalls))

    if (list.length === 0) {
      return <Text dimColor>No tool calls in this turn yet.</Text>
    }

    const bind = oneClick(TOOLS_PANEL)
    const toggle = (id: string) =>
      update($, openCalls, ids => (ids.includes(id) ? ids.filter(other => other !== id) : [...ids, id]))

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {list.length} {list.length === 1 ? 'call' : 'calls'} · click one for its input and output
        </Text>
        {list.map((call, index) => {
          const isOpen = open.has(call.id)
          const scope = `bar-call-${index}`

          return (
            <Box key={call.id} flexDirection="column" marginTop={index === 0 ? 1 : 0}>
              <Box flexDirection="row" columnGap={1} height={1} overflow="hidden">
                <Text color={STATUS_COLORS[call.status]}>●</Text>
                <Button
                  key={`call-${call.id}`}
                  label={`${isOpen ? '▾' : '▸'} ${call.tool}`}
                  plain
                  hover={{ scope, underline: true }}
                  onPress={bind(`call-${call.id}`, () => toggle(call.id))}
                />
                <Box flexGrow={1} flexShrink={1} overflow="hidden">
                  <Text dimColor wrap="truncate-end">
                    {call.summary}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text dimColor>{call.ms === null ? 'running' : duration(call.ms)}</Text>
                </Box>
              </Box>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={2} marginBottom={1}>
                  <Text dimColor>
                    {clockTime(call.startedAt)} · {call.status}
                  </Text>
                  <Text bold>Input</Text>
                  <Code source={call.input} language="json" />
                  <Text bold>Output</Text>
                  {call.output === null ? (
                    <Text dimColor>Still running</Text>
                  ) : (
                    <Code source={call.output || '(empty)'} />
                  )}
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
