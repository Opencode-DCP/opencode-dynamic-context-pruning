# Dynamic Context Pruning Plugin

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by removing obsolete tool outputs from conversation history.

## What It Does

This plugin automatically optimizes token usage by identifying and removing redundant or obsolete tool outputs from your conversation history. It operates in two modes:

### Pruning Modes

**Auto Mode** (`"auto"`): Fast, deterministic duplicate removal
- Removes duplicate tool calls (same tool + identical parameters)
- Keeps only the most recent occurrence of each duplicate
- Zero LLM inference costs
- Instant, predictable results

**Smart Mode** (`"smart"`): Comprehensive intelligent pruning (recommended)
- Phase 1: Automatic duplicate removal (same as auto mode)
- Phase 2: AI analysis to identify obsolete outputs (superseded information, dead-end exploration, etc.)
- Maximum token savings
- Small LLM cost for analysis (reduced by deduplication first)

When your session becomes idle, the plugin analyzes your conversation and prunes tool outputs that are no longer relevant, saving tokens and reducing costs.

## Installation

Add to your OpenCode configuration:

**Global:** `~/.config/opencode/opencode.json`  
**Project:** `.opencode/opencode.json`

```json
{
  "plugin": [
    "@tarquinen/opencode-dcp"
  ]
}
```

Restart OpenCode. The plugin will automatically start optimizing your sessions.

## Configuration

### Available Options

- **`enabled`** (boolean, default: `true`) - Enable/disable the plugin
- **`debug`** (boolean, default: `false`) - Enable detailed logging to `~/.config/opencode/logs/dcp/`
- **`model`** (string, optional) - Specific model for analysis (e.g., `"anthropic/claude-haiku-4-5"`). Uses session model or smart fallbacks when not specified.
- **`showModelErrorToasts`** (boolean, default: `true`) - Show notifications when model selection falls back
- **`pruningMode`** (string, default: `"smart"`) - Pruning strategy:
  - `"auto"`: Fast duplicate removal only (zero LLM cost)
  - `"smart"`: Deduplication + AI analysis (recommended, maximum savings)
- **`pruning_summary`** (string, default: `"detailed"`) - UI summary display mode:
  - `"off"`: No UI summary (silent pruning)
  - `"minimal"`: Show tokens saved and count only (e.g., "Saved ~2.5K tokens (6 tools pruned)")
  - `"detailed"`: Show full breakdown by tool type and pruning method
- **`protectedTools`** (string[], default: `["task", "todowrite", "todoread"]`) - Tools that should never be pruned

Example configuration:

```jsonc
{
  "enabled": true,
  "debug": false,
  "pruningMode": "smart",
  "pruning_summary": "detailed",
  "protectedTools": ["task", "todowrite", "todoread"]
}
```

### Configuration Hierarchy

1. **Built-in defaults** → 2. **Global config** (`~/.config/opencode/dcp.jsonc`) → 3. **Project config** (`.opencode/dcp.jsonc`)

The global config is automatically created on first run. Create project configs manually to override settings per-project:

```bash
mkdir -p .opencode
cat > .opencode/dcp.jsonc << 'EOF'
{
  "debug": true,
  "pruningMode": "auto"
}
EOF
```

After modifying configuration, restart OpenCode for changes to take effect.

### Choosing a Pruning Mode

**Use Auto Mode (`"auto"`) when:**
- Minimizing costs is critical (zero LLM inference for pruning)
- You have many repetitive tool calls (file re-reads, repeated commands)
- You want predictable, deterministic behavior
- You're debugging or testing and need consistent results

**Use Smart Mode (`"smart"`) when:**
- You want maximum token savings (recommended for most users)
- Your workflow has both duplicates and obsolete exploration
- You're willing to incur small LLM costs for comprehensive pruning
- You want the plugin to intelligently identify superseded information

**Example notification formats:**

**Detailed mode** (default):

Auto mode:
```
🧹 DCP: Saved ~1.2K tokens (5 duplicate tools removed)

read (3 duplicates):
  ~/project/src/index.ts (2× duplicate)
  ~/project/lib/utils.ts (1× duplicate)

bash (2 duplicates):
  Run tests (2× duplicate)
```

Smart mode:
```
🧹 DCP: Saved ~3.4K tokens (8 tools pruned)

📦 Duplicates removed (5):
  read:
    ~/project/src/index.ts (3×)
    ~/project/lib/utils.ts (2×)
  bash:
    Run tests (2×)

🤖 LLM analysis (3):
  grep (2):
    pattern: "old.*function"
    pattern: "deprecated"
  list (1):
    ~/project/temp
```

**Minimal mode** (`"pruning_summary": "minimal"`):
```
🧹 DCP: Saved ~3.4K tokens (8 tools pruned)
```

**Off mode** (`"pruning_summary": "off"`):
```
(No notification displayed - silent pruning)
```

To check the latest available version:

```bash
npm view @tarquinen/opencode-dcp version
```

### Version Pinning

If you want to ensure a specific version is always used or update your version, you can pin it in your config:

```json
{
  "plugin": [
    "@tarquinen/opencode-dcp@0.2.7"
  ]
}
```

## License

MIT
