# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run build       # Clean and compile TypeScript
npm run typecheck   # Type check without emitting
npm run dev         # Run in OpenCode plugin dev mode
npm run test        # Run tests (node --import tsx --test tests/*.test.ts)
```

## Architecture

This is an OpenCode plugin that optimizes token usage by pruning obsolete tool outputs from conversation context. The plugin is non-destructive—pruning state is kept in memory only, with original session data remaining intact.

### Core Components

**index.ts** - Plugin entry point. Registers:
- Global fetch wrapper that intercepts LLM requests and replaces pruned tool outputs with placeholder text
- Event handler for `session.status` idle events triggering automatic pruning
- `chat.params` hook to cache session model info
- `context_pruning` tool for AI-initiated pruning

**lib/janitor.ts** - Orchestrates the two-phase pruning process:
1. Deduplication phase: Fast, zero-cost detection of repeated tool calls (keeps most recent)
2. AI analysis phase: Uses LLM to semantically identify obsolete outputs

**lib/deduplicator.ts** - Implements duplicate detection by creating normalized signatures from tool name + parameters

**lib/model-selector.ts** - Model selection cascade: config model → session model → fallback models (with provider priority order)

**lib/config.ts** - Config loading with precedence: defaults → global (~/.config/opencode/dcp.jsonc) → project (.opencode/dcp.jsonc)

**lib/prompt.ts** - Builds the analysis prompt with minimized message history for LLM evaluation

### Key Concepts

- **Tool call IDs**: Normalized to lowercase for consistent matching
- **Protected tools**: Never pruned (default: task, todowrite, todoread, context_pruning)
- **Batch tool expansion**: When a batch tool is pruned, its child tool calls are also pruned
- **Strategies**: `deduplication` (fast) and `ai-analysis` (thorough), configurable per trigger (`onIdle`, `onTool`)

### State Management

Plugin maintains in-memory state per session:
- `prunedIdsState`: Map of session ID → array of pruned tool call IDs
- `statsState`: Map of session ID → cumulative pruning statistics
- `toolParametersCache`: Cached tool parameters extracted from LLM request bodies
- `modelCache`: Cached provider/model info from chat.params hook
