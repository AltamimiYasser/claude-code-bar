# Bar for Claude Code

A Claude Code mod that adds a status bar above the prompt, a live timer on every turn, and a frame that sets each final answer apart from the work before it. It works in the Claude desktop app's Code tab and in the terminal.

## What it shows

**The bar, above the prompt**

- **Context:** a meter and the tokens used against the model's context window (or a limit you set), going green → yellow → orange → red. Each pill's border is a faint version of its meter's color. Click **Context** to run `/usage`.
- **Plan limits:** your 5-hour and weekly usage with their reset times. Hover either one for the exact reset date and whether you're on pace to run out before it resets.
- **Cache:** how long the conversation stays in the prompt cache, counted down from Claude's last response (1 hour or 5 minutes, whichever the session uses). Once it expires, the next message has to write the whole conversation to the cache again. Hover it for the exact expiry time and how many tokens that would be.
- **Hand off:** a button inside the Cache pill (or `/bar-handoff`). It runs `/mattpocock-skills:handoff` to write a handoff document, then opens a new Code session in the same folder that continues from it. The current chat stays exactly as it is: it is never cleared or compacted. The desktop app asks you to trust the folder for the new session. When that session runs Bar, it sends the continue prompt by itself; otherwise the prompt is waiting in its message box. Requires the [mattpocock-skills](https://github.com/mattpocock/skills) plugin.
The app already shows the repo, branch, uncommitted changes and running tasks above the prompt, so Bar leaves those out.

**Every turn**

- While Claude works, the bar shows how long the turn has been running and the tokens it has used so far (input, output, cache read, cache write). It updates every second and stays in view as the reply scrolls. Between turns it shows the last turn's time and tokens. On the right: how many tools Claude called in that turn. Click it for a panel listing every call, each opening to its input and output.
- The final answer in an orange frame. Under the frame: how long the turn took, plus its input, output, cache-read and cache-write tokens.

**Remote Control, in the prompt footer**

A `○ Remote` toggle sits at the right of the footer under the message box. Click it, or run `/remote`, to start Remote Control for the project folder, and again to stop it. Its mark shows the state:

- `○ Remote`: off
- `🟡 Remote…`: starting
- `🟢 Remote`: connected
- `🔴 Remote`: the process stopped (the reason is in Remote sessions)

Beside it, **Sessions** opens a list of every folder that has had a Remote Control, running ones first, each with its folder and how long it has run (a stopped one shows when it stopped and how long it ran). Each row offers **Stop** while running, and **Start** and **Remove** once stopped. **Stop all** ends every running one. Remote Control processes you started yourself with `claude remote-control` show up too, marked "started outside Bar", and can be stopped.

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
| `/bar-limit 300k` | Sets where the context meter is full and turns red. It accepts `300k`, `1.5m` or `250000`, and is capped at the model's own window. `/bar-limit off` goes back to the model's window; `/bar-limit` on its own shows the current value. |
| `/remote` | Turns Remote Control on or off for this folder, like the footer toggle. `/remote list` opens Remote sessions; `/remote stop-all` stops every running one. |
| `/bar-handoff` | Writes a handoff and continues in a new session, like the Hand off button. |
| `/bar-demo` | Steps through sample bars (no plan limits, light use, getting full, past the limit), then back to your live bar. |

## Settings

Everything Bar shows can be turned off, in `~/.claude/bar/settings.jsonc`. Bar writes the file the first time it runs, with every option set to its default and a comment explaining it. Changes apply within a few seconds, with no restart. A wrong value falls back to its default, and a file that doesn't parse keeps the last good settings and shows a notice.

| Option | Default | What it controls |
| --- | --- | --- |
| `bar.enabled` | `true` | The whole bar above the prompt |
| `bar.hover` | `true` | Every hover effect: details, underlines, blue borders |
| `bar.pillBorders` | `true` | The light colored outline around each pill |
| `context.enabled` | `true` | The context pill |
| `context.limit` | `null` | Where the meter is full: `null` for the model's window, or a token count |
| `context.click` | `"usage"` | Clicking "Context": `"usage"` runs `/usage`, `"none"` does nothing |
| `planLimits.fiveHour` / `weekly` | `true` | The 5h and Week pills |
| `planLimits.resetTime` | `true` | The reset time after each percentage |
| `planLimits.hoverDetails` | `true` | The exact reset date while hovering a pill |
| `planLimits.pace` | `true` | The pace estimate in those details |
| `turn.enabled` | `true` | Line 2, the turn |
| `turn.whileWorking` / `lastTurn` | `true` | The live turn, and the last turn between turns |
| `turn.tokens` | `true` | The token figures on line 2 |
| `turn.toolCalls` / `toolCallsPanel` | `true` | The tool-call count, and the panel it opens |
| `answer.frame` / `footer` / `footerTokens` | `true` | The answer frame, the line under it, and its token figures |
| `spinnerTimer` | `true` | The live time beside the app's working indicator |
| `cache.enabled` | `true` | The Cache pill |
| `cache.handoff` | `true` | The Hand off button in it (`/bar-handoff` works either way) |
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
