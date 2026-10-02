# Bar for Claude Code

A Claude Code mod that adds a status bar above the prompt, a live timer on every turn, and a frame that sets each final answer apart from the work before it. It works in the Claude desktop app's Code tab and in the terminal.

## What it shows

**The bar, above the prompt**

- **Context:** a meter and the tokens used against your own limit (400k by default), going green → yellow → orange → red. Click **Context** to run `/usage`.
- **Plan limits:** your 5-hour and weekly usage with their reset times. Hover either one for the exact reset date and whether you're on pace to run out before it resets.
- **Workspace:** the folder and git branch, uncommitted changes (`+142 −37 5 files`), and running subagents.
  - Click the folder to open it in Finder.
  - Click the branch to open it on GitHub.
  - Click the file count to see the diff.
  - Click the agent count to list the subagents.

**Every turn**

- A timer under your message: live while Claude works, then the start and end times and the total.
- The final answer in an orange frame. Under the frame: how long the turn took, plus its input, output, cache-read and cache-write tokens.

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
| `/bar-limit 300k` | Sets where the context meter is full and turns red. It accepts `300k`, `1.5m` or `250000`, and is capped at the model's own window. On its own, `/bar-limit` shows the current value. |
| `/bar-demo` | Steps through sample bars (a plain folder, a clean repo, uncommitted work with agents, past the limit), then back to your live bar. |

The context limit is also a plugin setting (`contextLimit`) in Claude Code's settings menu.

## Development

The plugin lives in [`plugins/bar`](plugins/bar). Check it with:

```bash
claude plugin validate plugins/bar
```

For type checking, open Claude Code in `plugins/bar`, run `/plugin-types` (it writes the API declarations to `.claude/types`), then run:

```bash
npx -p typescript tsc -p plugins/bar
```

To load your working copy instead of the installed one:

```bash
claude --plugin-dir plugins/bar
```

## License

[MIT](LICENSE)
