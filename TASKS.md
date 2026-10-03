# Bar 1.2.0

- [x] Research: ways to screenshot the Claude desktop app (background agent)
- [x] Settings file `~/.claude/bar/settings.jsonc`: written with defaults and comments on first run, read every few seconds
- [x] Context limit defaults to the model's own window (`context.limit: null`); `/bar-limit` writes the file
- [x] Every setting wired: bar, context, plan limits, turn line, answer frame, spinner timer, Remote Control, levels, hover
- [x] Remote Control `autoStart`: never / newProjects / always
- [x] Tests: one per setting, run with the plugin test kit
- [x] Load the plugin in every new session (CLAUDE_CODE_PLUGIN_DIRS → repo), keep the published copy disabled
- [x] README: settings section
- [x] Cap the Remote Control log (it grew ~600 KB in 20 minutes)
- [x] Remote sessions button and panel: every folder's instance, Stop / Start / Remove / Stop all, outside-Bar processes
- [ ] Live checks in the app: settings changes apply, autoStart in a brand-new project, notifications
- [ ] Test Remote Control sync across two sessions
- [x] Publish 1.2.0, re-enable the installed plugin
- [x] Remote sessions panel: running times move every second while the panel is shown; a stopped one shows a fixed "stopped at 22:31 · ran 4m 2s" instead of a counter
- [x] One click for the panels' buttons: the desktop app spends the first click on a pane button moving the focus there, so the ring landing on a button presses it (hooks/one-click.ts)

# Bar 1.3.0

- [x] Cache pill: time left before the prompt cache lapses (5m or 1h, read from the transcript's cache writes), counted from the last main-loop response
- [x] Hand off button and /bar-handoff: runs /mattpocock-skills:handoff into a known path, then opens a new Code session in this folder (claude://code/new?folder=&q=) continuing from it; this chat stays as is
- [x] The new session's Bar sends the continue prompt itself (a claim file in ~/.claude/bar/handoff/), else it waits in the box
- [x] Settings `cache.enabled` / `cache.handoff`; tests
- [ ] Live check: pill, hover detail, Hand off end to end (handoff written and new session opened ✓; the new session's auto-send still unseen: it needs Bar running there)
- [x] Cache pill kept a fixed width: countdown and button label in fixed-width boxes, short labels (Writing… / Opening… / Opened ✓ / Failed); the Context pill can shrink to make room
- [x] Checked the process against mattpocock's handoff docs: only the old session runs the skill; the new one just reads the file
- [x] README: Cache, Hand off, /bar-handoff, cache.* settings
- [x] Publish 1.3.0, re-enable the installed plugin, remove the dev copies

# Bar 1.4.0: the instrument panel

- [x] Context pill shows the count and the percentage in a slot that never shrinks; the meter fills the room left and gives it up first
- [x] Desktop meters drawn as stretching SVG (hooks/meter.ts): hairline track, ticks ahead at the colour levels, a fill brightening to a glowing bead; follows the app's light/dark text colour
- [x] Three restyle directions mocked with only what the desktop draws; Yasser chose A (instrument panel)
- [x] One panel, two rows: capacity (Context, 5h, Week) and right now (turn, tools, Cache, Hand off), hairline dividers
- [x] 5h/Week meters with a "now" mark (how much of the window has passed)
- [x] Working beat (SVG pulse, once a second), resting ring between turns, output-rate sparkline (samples each second in turns.tsx)
- [x] Hand off is the app's real button, solid (primary) once the cache is orange/red/expired
- [x] Hover details on the other row: Context, 5h, Week over row 2; the turn and the cache over row 1, so Hand off is never covered
- [x] Terminal fallback in glyphs; dividers never shrink (one rounded to nothing); first row keeps 4 cells for the band's `[-]` (checked in tmux, idle, working, after)
- [x] Tests (52), README "how to read" section, settings comments, a visual legend page
- [x] Live check in the desktop app (screenshot from Yasser: approved)
- [x] Publish 1.4.0, re-enable the installed plugin, remove the dev copy

# Bar 1.4.1: Context meter at the auto-compact window

- [x] `context.limit` defaults to `"autoCompact"` (read from the engine's context breakdown, `rawMaxTokens`); `"model"` and a number still work; old `null` reads as `"autoCompact"`
- [x] `/bar-limit off | model | 300k`; the model's window known before the first response
- [x] Tests (53), README, checked live in the terminal (400k before and after a reply)
- [x] Published 1.4.1 and installed
