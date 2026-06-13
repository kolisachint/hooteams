# Changelog

## [Unreleased]

### Added
- New package: the `TaskDag` — topological order (Kahn), ready/blocked tracking, retry/rework helpers, JSON persistence and crash-recovery (`toJSON`/`fromJSON`/`resetTransient`) — extracted from `@kolisachint/hooteams-orchestrator` into this dependency-free foundation layer (its only import is the `AgentMessage` type from `@kolisachint/hoocode-agent-core`). Re-exported from the orchestrator barrel, so existing consumers are unaffected.
- Immutable node snapshots: accessors (`get`/`all`/`ready`/`blocked`/`resetToIdle`/`add`) return frozen shallow copies, so callers can never mutate internal node state through a live reference (a write throws in strict mode). All node mutation goes through the dag's own methods, including the new `setOutput(id, output)` and `incrementAttempts(id)`. `add()` no longer writes an `undefined` `retries` key.
