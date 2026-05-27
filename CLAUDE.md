# Fleet

Agent dashboard TUI for managing AI agent sessions in tmux. Also a Claude Code plugin for hook auto-discovery.

## Architecture

Bash hooks write state → Bun TUI reads state. Three-layer state engine: hook signals, JSONL event stream, pane scraping.

## Development

- Runtime: Bun
- Build: `bun run build` (compiles to standalone binary)
- Test: `bun test`
- Lint: `bun run lint`
- Format: `bun run format`
- Typecheck: `bun run typecheck`
- Dev: `bun run dev` (runs without compiling)

## Conventions

- Zero runtime dependencies
- TypeScript strict mode with noUncheckedIndexedAccess
- Collocated tests: `*.test.ts` next to source
- Raw ANSI rendering (no TUI framework)
- Single-string-per-frame rendering (no flicker)
