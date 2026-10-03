# Bar for Claude Code

A Claude Code mod that adds a status bar above the prompt, a live timer on every turn, and a frame that sets each final answer apart from the work before it. It works in the Claude desktop app's Code tab and in the terminal.

## What it shows

**The bar, above the prompt**

One panel with two rows. Row 1 is capacity: how full things are. Row 2 is right now: the turn, its tools, the prompt cache and Hand off. Every gauge is the same drawing: a thin track, a fill that brightens toward its end, and a bead (a dot with a white centre) marking where you are. Hover any item and its full detail appears laid over the other row.

*Row 1: capacity*

- **Context** `━━━━●───┊──┊──  216k / 1.0M  22%`: how full this chat's context window is. The bold number is the tokens in the conversation, `/ 400k` is the limit (your auto-compact window when you've set one, else the model's window, or your own from `/bar-limit`), then the share. The faint ticks on the track mark where the next colours start; only the ones still ahead are drawn. Click **Context** to run `/usage`.
- **5h** and **Week** `━━●─┃──  30%  07:20`: your plan's 5-hour window and weekly limit. The bold percentage is how much you've used; the dim time or day is when it resets. The upright mark on the line is **now**: how much of the window has passed. Bead left of the mark: you're using it slower than the clock, fine. Bead right of the mark: you're ahead of pace and may run out before it resets. Hover for the exact reset date and where you'll land at this pace.

*Row 2: right now*

- **The beat:** an orange bead with a ring swelling once a second means Claude is working; the beat keeps time with the timer. A hollow grey ring means idle, and the row shows the last turn.
- **Working 1m 04s** (orange) or **Last turn 16s**: how long the turn has run, or took.
- **The sparkline** (while working): output tokens per second over the last 24 seconds, the bead being now. High means Claude is writing fast; flat means it's thinking, or waiting on a tool.
- **The figures:** `out` is the tokens Claude wrote (a `+` means more are still streaming in), `read` the tokens served from the prompt cache, `write` the tokens newly written to it. Hover the turn for all four, with `in` (input outside the cache) and the tool calls.
- **3 tools ›**: how many tools Claude called this turn. Click it for a panel listing every call, each opening to its input and output.
- **Cache 59:27**: how long the conversation stays in the prompt cache, counted down from Claude's last response (1 hour or 5 minutes, whichever the session uses). Once it expires, the next message has to write the whole conversation to the cache again. Hover for the exact expiry time and how many tokens that would be.
- **Hand off →** (or `/bar-handoff`): runs `/mattpocock-skills:handoff` to write a handoff document, then opens a new Code session in the same folder that continues from it. The current chat stays exactly as it is: it is never cleared or compacted. The button is outlined most of the time and turns solid once the cache is running out (orange or red), the moment it's worth pressing. While it works it reads Writing…, Opening…, then Opened ✓ (or Failed, with the reason on hover). The desktop app asks you to trust the folder for the new session. When that session runs Bar, it sends the continue prompt by itself; otherwise the prompt is waiting in its message box. Requires the [mattpocock-skills](https://github.com/mattpocock/skills) plugin.

*The colours*

| Colour | On a meter or a countdown |
| --- | --- |
| Green | under half used |
| Yellow | from half (`levels.yellow`, 50%) |
| Orange | from three quarters (`levels.orange`, 75%) |
| Red | at or past the limit (`levels.red`, 100%); the cache has expired |

Orange in the turn (the beat, the timer, the sparkline) is Claude's own colour: it only means Claude is working. A bold number is the value to read; dim text is a label or a unit.

In the terminal the same panel is drawn in characters: `━` used, `─` the track, `┃` the now mark, `●` working, `○` idle, `│` between items, and Hand off as `[ Hand off → ]`.

The app already shows the repo, branch, uncommitted changes and running tasks above the prompt, so Bar leaves those out.

**Every turn**

- The final answer in an orange frame. Under the frame: how long the turn took, plus its input, output, cache-read and cache-write tokens.

**Remote Control, in the prompt footer**

A `○ Remote` toggle sits at the right of the footer under the message box. Click it, or run `/remote`, to start Remote Control for the project folder, and again to stop it. Its mark shows the state:

- `○ Remote`: off
- `🟡 Remote…`: starting
- `🟢 Remote`: connected
- `🔴 Remote`: the process stopped (the reason is in Remote sessions)

Beside it, **Sessions** opens a list of every folder that has had a Remote Control, running ones first, each with its folder and how long it has run (a stopped one shows when it stopped and how long it ran). Each row offers **Stop** while running, and **Start** and **Remove** once stopped. **Stop all** ends every running one. Remote Control processes you started yourself with `claude remote-control` show up too, marked "started outside Bar", and can be stopped.

Anything another mod adds to the footer (a button of its own, say) stays there, before **Sessions**.

There's one Remote Control per folder, shared by every session in it. It keeps running after the session that started it ends, and any session opened in that folder later shows it and can turn it off. Its process ID and log are kept in `~/.claude/bar/remote/`.

## Install

In Claude Code:

```
/plugin marketplace add AltamimiYasser/claude-code-bar
/plugin install bar@claude-code-bar
```

Or from a shell:

```bash
claude plugin marketplace add AltamimiYasser/claude-code-bar
claude plugin install bar@claude-code-bar
```

Start a new session afterwards.

**Requirement:** Bar is a mod, a plugin made of function hooks, and function hooks are in early access. If the bar doesn't appear, set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your environment, or in the `env` block of `~/.claude/settings.json`.

## Commands

| Command | What it does |
| --- | --- |
| `/bar-limit 300k` | Sets where the context meter is full and turns red. It accepts `300k`, `1.5m` or `250000`, and is capped at the model's own window. `/bar-limit model` uses the model's whole window; `/bar-limit off` goes back to the default, your auto-compact window; `/bar-limit` on its own shows the current value. |
| `/remote` | Turns Remote Control on or off for this folder, like the footer toggle. `/remote list` opens Remote sessions; `/remote stop-all` stops every running one. |
| `/bar-handoff` | Writes a handoff and continues in a new session, like the Hand off button. |
| `/bar-demo` | Steps through sample bars (no plan limits, light use, getting full, past the limit), then back to your live bar. |

## Settings

Everything Bar shows can be turned off, in `~/.claude/bar/settings.jsonc`. Bar writes the file the first time it runs, with every option set to its default and a comment explaining it. Changes apply within a few seconds, with no restart. A wrong value falls back to its default, and a file that doesn't parse keeps the last good settings and shows a notice.

| Option | Default | What it controls |
| --- | --- | --- |
| `bar.enabled` | `true` | The whole bar above the prompt |
| `bar.hover` | `true` | Every hover effect: the details, the underlines |
| `bar.pillBorders` | `true` | The faint outline around the bar's panel (desktop) |
| `context.enabled` | `true` | The Context meter |
| `context.limit` | `"autoCompact"` | Where the meter is full: `"autoCompact"` for your auto-compact window (`autoCompactWindow` in Claude Code's settings; the model's window when none is set), `"model"` for the model's own window, or a token count. An older file's `null` reads as `"autoCompact"` |
| `context.click` | `"usage"` | Clicking "Context": `"usage"` runs `/usage`, `"none"` does nothing |
| `planLimits.fiveHour` / `weekly` | `true` | The 5h and Week meters |
| `planLimits.resetTime` | `true` | The reset time after each percentage |
| `planLimits.hoverDetails` | `true` | The exact reset date while hovering 5h or Week |
| `planLimits.pace` | `true` | The "now" mark on the 5h and Week meters, and the pace estimate in their details |
| `turn.enabled` | `true` | The turn on row 2 (the cache and Hand off stay) |
| `turn.whileWorking` / `lastTurn` | `true` | The live turn (beat, time, sparkline), and the last turn between turns |
| `turn.tokens` | `true` | The token figures on row 2 |
| `turn.toolCalls` / `toolCallsPanel` | `true` | The tool-call count, and the panel it opens |
| `answer.frame` / `footer` / `footerTokens` | `true` | The answer frame, the line under it, and its token figures |
| `spinnerTimer` | `true` | The live time beside the app's working indicator |
| `cache.enabled` | `true` | The Cache countdown |
| `cache.handoff` | `true` | The Hand off button beside it (`/bar-handoff` works either way) |
| `remote.enabled` | `true` | The Remote Control toggle and `/remote` |
| `remote.autoStart` | `"newProjects"` | Start Remote Control by itself: `"never"`, `"newProjects"` (a project's first session) or `"always"` |
| `remote.notifications` | `true` | The on/off notices |
| `remote.sessionsButton` | `true` | The Remote sessions button in the footer |
| `levels.yellow` / `orange` / `red` | `0.5` / `0.75` / `1.0` | The share of a limit where colors change |

## Development

The plugin lives in [`plugins/bar`](plugins/bar). Check it with:

```bash
claude plugin validate plugins/bar
```

For type checking, open Claude Code in `plugins/bar`, run `/plugin-types` (it writes the API declarations to `.claude/types`), then run:

```bash
npx -p typescript tsc -p plugins/bar
```

Run the tests (the plugin test kit needs function hooks switched on):

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/bar
```

To load your working copy instead of the installed one:

```bash
claude --plugin-dir plugins/bar
```

## License

[MIT](LICENSE)
