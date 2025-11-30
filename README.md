# Dynamic Context Pruning Plugin

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by removing obsolete tool outputs from conversation history.

![DCP in action](dcp-demo.png)

## Installation

Add to your OpenCode config:

```jsonc
// opencode.jsonc
{
  "plugin": ["@tarquinen/opencode-dcp@0.3.26"]
}
```

When a new version is available, DCP will show a toast notification. Update by changing the version number in your config.

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## Pruning Strategies

DCP implements two complementary strategies:

**Deduplication** — Fast, zero-cost pruning that identifies repeated tool calls (e.g., reading the same file multiple times) and keeps only the most recent output. Runs instantly with no LLM calls.

**AI Analysis** — Uses a language model to semantically analyze conversation context and identify tool outputs that are no longer relevant to the current task. More thorough but incurs LLM cost.

## Context Pruning Tool

When `strategies.onTool` is enabled, DCP exposes a `context_pruning` tool to Opencode that the AI can call to trigger pruning on demand.

When `nudge_freq` is enabled, injects reminders (every `nudge_freq` tool results) prompting the AI to consider pruning when appropriate.

## How It Works

Your session history is never modified. DCP replaces pruned outputs with a placeholder before sending requests to your LLM.

## Impact on Prompt Caching

LLM providers like Anthropic and OpenAI cache prompts based on exact prefix matching. When DCP prunes a tool output, it changes the message content, which invalidates cached prefixes from that point forward.

**Trade-off:** You lose some cache read benefits but gain larger token savings from reduced context size. In most cases, the token savings outweigh the cache miss cost—especially in long sessions where context bloat becomes significant.

## Configuration

DCP uses its own config file (`~/.config/opencode/dcp.jsonc` or `.opencode/dcp.jsonc`), created automatically on first run.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the plugin |
| `debug` | `false` | Log to `~/.config/opencode/logs/dcp/` |
| `model` | (session) | Model for analysis (e.g., `"anthropic/claude-haiku-4-5"`) |
| `showModelErrorToasts` | `true` | Show notifications on model fallback |
| `strictModelSelection` | `false` | Only run AI analysis with session or configured model (disables fallback models) |
| `pruning_summary` | `"detailed"` | `"off"`, `"minimal"`, or `"detailed"` |
| `nudge_freq` | `10` | How often to remind AI to prune (lower = more frequent) |
| `protectedTools` | `["task", "todowrite", "todoread", "context_pruning"]` | Tools that are never pruned |
| `strategies.onIdle` | `["deduplication", "ai-analysis"]` | Strategies for automatic pruning |
| `strategies.onTool` | `["deduplication", "ai-analysis"]` | Strategies when AI calls `context_pruning` |

**Strategies:** `"deduplication"` (fast, zero LLM cost) and `"ai-analysis"` (maximum savings). Empty array disables that trigger.

```jsonc
{
  "enabled": true,
  "strategies": {
    "onIdle": ["deduplication", "ai-analysis"],
    "onTool": ["deduplication", "ai-analysis"]
  },
  "protectedTools": ["task", "todowrite", "todoread", "context_pruning"]
}
```

### Config Precedence

Settings are merged in order: **Defaults** → **Global** (`~/.config/opencode/dcp.jsonc`) → **Project** (`.opencode/dcp.jsonc`). Each level overrides the previous, so project settings take priority over global, which takes priority over defaults.

Restart OpenCode after making config changes.

## License

MIT
