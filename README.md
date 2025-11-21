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

## Updating

OpenCode automatically installs plugins from npm to `~/.cache/opencode/node_modules/`. To force an update to the latest version:

```bash
cd ~/.cache/opencode
rm -rf node_modules/@tarquinen
sed -i.bak '/"@tarquinen\/opencode-dcp"/d' package.json
```

Then restart OpenCode, and it will automatically install the latest version.

To check your current version:

```bash
cat ~/.cache/opencode/node_modules/@tarquinen/opencode-dcp/package.json | grep version
```

To check the latest available version:

```bash
npm view @tarquinen/opencode-dcp version
```

### Version Pinning

If you want to ensure a specific version is always used, you can pin it in your config:

```json
{
  "plugin": [
    "@tarquinen/opencode-dcp@0.1.11"
  ]
}
```

## Debug Logging

Enable debug logging by setting the `OPENCODE_DCP_DEBUG` environment variable:

```bash
# For one session
OPENCODE_DCP_DEBUG=1 opencode

# For all sessions
export OPENCODE_DCP_DEBUG=1
opencode
```

Logs are written to `~/.config/opencode/logs/dcp/YYYY-MM-DD.log`.

Watch logs in real-time:

```bash
tail -f ~/.config/opencode/logs/dcp/$(date +%Y-%m-%d).log
```

## License

MIT
