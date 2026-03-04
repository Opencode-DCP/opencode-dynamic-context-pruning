# Dynamic Context Pruning Plugin

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/dansmolsky)
[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by managing conversation context.

![DCP in action](assets/images/dcp-demo5.png)

## Installation

Add to your OpenCode config:

```jsonc
// opencode.jsonc
{
    "plugin": ["@tarquinen/opencode-dcp@beta"],
}
```

Using `@beta` ensures you always get the newest version automatically when OpenCode starts.

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## How It Works

DCP reduces context size through a compress tool and automatic cleanup. Your session history is never modified — DCP replaces pruned content with placeholders before sending requests to your LLM.

### Compress

A tool exposed to your model that selects a conversation range and replaces it with a technical summary. When a new compression overlaps an earlier one, the earlier summary is nested inside the new one — so information is preserved through layers of compression rather than diluted away.

The model compresses at whatever scale fits: small ranges for noise cleanup, focused ranges for key findings, or broad ranges for completed work. Context thresholds (`minContextLimit`, `maxContextLimit`) and nudge settings control how aggressively the model is prompted to compress.

### Deduplication

Identifies repeated tool calls (same tool, same arguments) and keeps only the most recent output. Recalculated when the compress tool runs, so prompt cache is only impacted alongside compression.

### Purge Errors

Prunes inputs from errored tool calls after a configurable number of turns (default: 4). Error messages are preserved; only the potentially large input content is removed. Recalculated on compress tool use.

## Configuration

DCP uses its own config file:

- Global: `~/.config/opencode/dcp.jsonc` (or `dcp.json`), created automatically on first run
- Custom config directory: `$OPENCODE_CONFIG_DIR/dcp.jsonc` (or `dcp.json`), if `OPENCODE_CONFIG_DIR` is set
- Project: `.opencode/dcp.jsonc` (or `dcp.json`) in your project's `.opencode` directory

> [!IMPORTANT]
> Defaults are applied automatically. Expand this if you want to review or override settings.

<details>
<summary><strong>Default Configuration</strong> (click to expand)</summary>

```jsonc
{
    "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
    // Enable or disable the plugin
    "enabled": true,
    // Enable debug logging to ~/.config/opencode/logs/dcp/
    "debug": false,
    // Notification display: "off", "minimal", or "detailed"
    "pruneNotification": "detailed",
    // Notification type: "chat" (in-conversation) or "toast" (system toast)
    "pruneNotificationType": "chat",
    // Slash commands configuration
    "commands": {
        "enabled": true,
        // Additional tools to protect from pruning via commands (e.g., /dcp sweep)
        "protectedTools": [],
    },
    // Manual mode: disables autonomous context management,
    // tools only run when explicitly triggered via /dcp commands
    "manualMode": {
        "enabled": false,
        // When true, automatic cleanup (deduplication, purgeErrors)
        // still runs even in manual mode
        "automaticStrategies": true,
    },
    // Protect from pruning for <turns> message turns past tool invocation
    "turnProtection": {
        "enabled": false,
        "turns": 4,
    },
    // Experimental settings
    "experimental": {
        // Allow DCP processing in subagent sessions
        "allowSubAgents": false,
        // Enable user-editable prompt overrides under dcp-prompts directories
        // When false (default), prompt override files/directories are ignored
        "customPrompts": false,
    },
    // Protect file operations from pruning via glob patterns
    // Patterns match tool parameters.filePath (e.g. read/write/edit)
    "protectedFilePatterns": [],
    // Unified context compression tool and behavior settings
    "compress": {
        // Permission mode: "allow" (no prompt), "ask" (prompt), "deny" (tool not registered)
        "permission": "allow",
        // Show compression content in a chat notification
        "showCompression": false,
        // Soft upper threshold: above this, DCP keeps injecting strong
        // compression nudges (based on nudgeFrequency), so compression is
        // much more likely. Accepts: number or "X%" of model context window.
        "maxContextLimit": 100000,
        // Soft lower threshold for reminder nudges: below this, turn/iteration
        // reminders are off (compression less likely). At/above this, reminders
        // are on. Accepts: number or "X%" of model context window.
        "minContextLimit": 30000,
        // Optional per-model override for maxContextLimit by providerID/modelID.
        // If present, this wins over the global maxContextLimit.
        // Accepts: number or "X%".
        // Example:
        // "modelMaxLimits": {
        //     "openai/gpt-5.3-codex": 120000,
        //     "anthropic/claude-sonnet-4.6": "80%"
        // },
        // Optional per-model override for minContextLimit.
        // If present, this wins over the global minContextLimit.
        // "modelMinLimits": {
        //     "openai/gpt-5.3-codex": 30000,
        //     "anthropic/claude-sonnet-4.6": "25%"
        // },
        // How often the context-limit nudge fires (1 = every fetch, 5 = every 5th)
        "nudgeFrequency": 5,
        // Start adding compression reminders after this many
        // messages have happened since the last user message
        "iterationNudgeThreshold": 15,
        // Controls how likely compression is after user messages
        // ("strong" = more likely, "soft" = less likely)
        "nudgeForce": "soft",
        // Tool names whose completed outputs are appended to the compression
        "protectedTools": [],
    },
    // Automatic pruning strategies
    "strategies": {
        // Remove duplicate tool calls (same tool with same arguments)
        "deduplication": {
            "enabled": true,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
        // Prune write tool inputs when the file has been subsequently read
        "supersedeWrites": {
            "enabled": true,
        },
        // Prune tool inputs for errored tools after X turns
        "purgeErrors": {
            "enabled": true,
            // Number of turns before errored tool inputs are pruned
            "turns": 4,
            // Additional tools to protect from pruning
            "protectedTools": [],
        },
    },
}
```

</details>

### Commands

DCP provides a `/dcp` slash command:

- `/dcp` — Shows available DCP commands
- `/dcp context` — Shows a breakdown of your current session's token usage by category (system, user, assistant, tools, etc.) and how much has been saved through pruning.
- `/dcp stats` — Shows cumulative pruning statistics across all sessions.
- `/dcp sweep` — Prunes all tools since the last user message. Accepts an optional count: `/dcp sweep 10` prunes the last 10 tools. Respects `commands.protectedTools`.
- `/dcp manual [on|off]` — Toggle manual mode or set explicit state. When on, the AI will not autonomously use context management tools.

- `/dcp compress [focus]` — Trigger a single compress tool execution. Optional focus text directs what range to compress.
- `/dcp decompress <n>` — Restore a specific active compression by ID (for example `/dcp decompress 2`). Running without an argument shows available compression IDs, token sizes, and topics.
- `/dcp recompress <n>` — Re-apply a user-decompressed compression by ID (for example `/dcp recompress 2`). Running without an argument shows recompressible IDs, token sizes, and topics.

### Prompt Overrides

DCP exposes six editable prompts:

- `system`
- `compress`
- `context-limit-nudge`
- `user-turn-nudge`
- `assistant-turn-nudge`
- `iteration-nudge`

This feature is disabled by default. Set `experimental.customPrompts` to `true` in your DCP config to activate it.

When enabled, managed defaults are written to `~/.config/opencode/dcp-prompts/defaults/` as plain-text prompt files. A single `README.md` in that directory explains each prompt and how to create overrides.

To customize behavior, add a file with the same name under an overrides directory and edit it as plain text.

To reset an override, delete the matching file from your overrides directory.

> [!NOTE]
> `compress` prompt changes apply after plugin restart because tool descriptions are registered at startup.

### Protected Tools

By default, these tools are always protected from pruning:
`task`, `skill`, `todowrite`, `todoread`, `compress`, `batch`, `plan_enter`, `plan_exit`

The `protectedTools` arrays in `commands` and `strategies` add to this default list.

For the `compress` tool, `compress.protectedTools` ensures specific tool outputs are appended to the compressed summary. It defaults to an empty array `[]` but always inherently protects `task`, `skill`, `todowrite`, and `todoread`.

### Config Precedence

Settings are merged in order:
Defaults → Global (`~/.config/opencode/dcp.jsonc`) → Config Dir (`$OPENCODE_CONFIG_DIR/dcp.jsonc`) → Project (`.opencode/dcp.jsonc`).
Each level overrides the previous, so project settings take priority over config-dir and global, which take priority over defaults.

Restart OpenCode after making config changes.

## Impact on Prompt Caching

LLM providers cache prompts based on exact prefix matching. When DCP prunes content, it changes messages, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache reads but gain token savings from reduced context size and fewer hallucinations from stale context. In most cases, especially in long sessions, the savings outweigh the cache miss cost.

> **Note:** In testing, cache hit rates were approximately 85% with DCP vs 90% without.

**No impact for:**

- **Request-based billing** — Providers like Github Copilot that charge per request, not tokens.
- **Uniform token pricing** — Providers like Cerebras that bill cached and uncached tokens at the same rate.

## Limitations

**Subagents** — Disabled by default. Subagent sessions prioritize returning concise summaries to the main agent, and pruning could interfere with that. Opt in with `experimental.allowSubAgents: true`.

## License

AGPL-3.0-or-later
