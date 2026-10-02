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
