# DCP CLI

Dev tool for previewing prompt outputs. Verify parsing works correctly and quickly check specific tool combinations.

## Usage

```bash
bun run dcp [TYPE] [-d] [-e] [-s]
```

## Types

| Flag               | Description                 |
| ------------------ | --------------------------- |
| `--system`         | System prompt               |
| `--nudge`          | Nudge prompt                |
| `--prune-list`     | Example prunable tools list |
| `--squash-context` | Example squash context      |

## Tool Flags

| Flag            | Description         |
| --------------- | ------------------- |
| `-d, --discard` | Enable discard tool |
| `-e, --extract` | Enable extract tool |
| `-s, --squash`  | Enable squash tool  |

If no tool flags specified, all are enabled.

## Examples

```bash
bun run dcp --system -d -e -s   # System prompt with all tools
bun run dcp --system -d         # System prompt with discard only
bun run dcp --nudge -e -s       # Nudge with extract and squash
bun run dcp --prune-list        # Example prunable tools list
```

## Purpose

This CLI does NOT ship with the plugin. It's purely for DX - iterate on prompt templates and verify the `<tool></tool>` conditional parsing produces the expected output.
