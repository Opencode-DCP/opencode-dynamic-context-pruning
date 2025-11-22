# Dynamic Context Pruning Plugin

[![npm version](https://img.shields.io/npm/v/@tarquinen/opencode-dcp.svg)](https://www.npmjs.com/package/@tarquinen/opencode-dcp)

Automatically reduces token usage in OpenCode by removing obsolete tool outputs from conversation history.

## What It Does

When your OpenCode session becomes idle, this plugin analyzes your conversation and identifies tool outputs that are no longer relevant (superseded file reads, old errors that were fixed, exploratory searches, etc.). These obsolete outputs are pruned from future requests to save tokens and reduce costs.

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

The plugin supports both global and project-level configuration:

- **Global:** `~/.config/opencode/dcp.jsonc` - Applies to all OpenCode sessions
- **Project:** `.opencode/dcp.jsonc` - Applies only to the current project

Project configuration takes precedence over global configuration. The plugin creates a default global configuration file on first run.

```jsonc
{
  // Enable or disable the Dynamic Context Pruning plugin
  "enabled": true,

  // Enable debug logging to ~/.config/opencode/logs/dcp/YYYY-MM-DD.log
  "debug": false,

  // Optional: Use a specific model for analysis (otherwise uses session model or smart fallbacks)
  // "model": "anthropic/claude-haiku-4-5",

  // Show toast notifications when model selection fails and falls back
  "showModelErrorToasts": true,

  // List of tools that should never be pruned from context
  // The 'task' tool is protected by default to preserve subagent coordination
  "protectedTools": ["task"]
}
```

### Configuration Hierarchy

1. **Defaults** - Built-in plugin defaults
2. **Global config** (`~/.config/opencode/dcp.jsonc`) - Overrides defaults
3. **Project config** (`.opencode/dcp.jsonc`) - Overrides global config

This allows you to:
- Set global defaults for all projects
- Override settings per-project (e.g., disable for sensitive projects, use different models)
- Commit project config to version control for team consistency

### Creating Project-Level Config

To create a project-specific configuration:

1. Create `.opencode` directory in your project root (if it doesn't exist)
2. Create `dcp.jsonc` file inside `.opencode/`
3. Add your project-specific settings

```bash
# In your project directory
mkdir -p .opencode
cat > .opencode/dcp.jsonc << 'EOF'
{
  // Project-specific DCP settings
  "debug": true,
  "protectedTools": ["task", "read"]
}
EOF
```

The global config (`~/.config/opencode/dcp.jsonc`) is automatically created on first run. Project configs are opt-in and must be created manually.

### Configuration Options

- **`enabled`** (boolean, default: `true`)  
  Enable or disable the plugin without removing it from your OpenCode configuration.

- **`debug`** (boolean, default: `false`)  
  Enable detailed debug logging. Logs are written to `~/.config/opencode/logs/dcp/YYYY-MM-DD.log`.

- **`model`** (string, optional)  
  Optional: Specify a model to use for analysis in "provider/model" format (e.g., `"anthropic/claude-haiku-4-5"`). When not specified, the plugin uses the current session model or falls back to authenticated providers in priority order.

- **`showModelErrorToasts`** (boolean, default: `true`)  
  Show toast notifications when model selection fails and falls back to another model. Set to `false` to disable these informational toasts.

- **`protectedTools`** (string[], default: `["task"]`)  
  List of tool names that should never be pruned from context. The `task` tool is protected by default to ensure subagent coordination works correctly.

After modifying the configuration, restart OpenCode for changes to take effect.

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
