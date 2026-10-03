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
