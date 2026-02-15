# DCP CLI

Dev tool for previewing prompt outputs.

## Usage

```bash
bun run dcp [TYPE]
```

## Types

| Flag                 | Description                              |
| -------------------- | ---------------------------------------- |
| `--system`           | System prompt                            |
| `--nudge`            | Standard nudge prompt                    |
| `--compress-nudge`   | Context-limit compress nudge             |
| `--context-tools`    | Example `<context-pressure-tools>` block |
| `--compress-context` | Example `<compress-context>` block       |
| `--cooldown`         | Cooldown context-info block              |

## Examples

```bash
bun run dcp --system
bun run dcp --nudge
bun run dcp --context-tools
```

## Purpose

This CLI does not ship with the plugin. It is for local DX while iterating on injected prompts.
