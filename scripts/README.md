# DCP CLI

Dev tool for previewing prompt outputs. Verify parsing works correctly and quickly check specific tool combinations.

## Usage

```bash
bun run dcp [TYPE] [-p] [-d] [-c]
```

## Types

| Flag                 | Description                 |
| -------------------- | --------------------------- |
| `--system`           | System prompt               |
| `--nudge`            | Nudge prompt                |
| `--prune-list`       | Example prunable tools list |
| `--compress-context` | Example compress context    |

## Tool Flags

| Flag             | Description          |
| ---------------- | -------------------- |
| `-d, --distill`  | Enable distill tool  |
| `-c, --compress` | Enable compress tool |
| `-p, --prune`    | Enable prune tool    |

If no tool flags specified, all are enabled.

## Examples

```bash
bun run dcp --system -p -d -c   # System prompt with all tools
bun run dcp --system -p         # System prompt with prune only
bun run dcp --nudge -d -c       # Nudge with distill and compress
bun run dcp --prune-list        # Example prunable tools list
```

## Purpose

This CLI does NOT ship with the plugin. It's purely for DX - iterate on prompt templates and verify the `<tool></tool>` conditional parsing produces the expected output.
