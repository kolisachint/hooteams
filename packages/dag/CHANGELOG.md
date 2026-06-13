# Changelog

## [0.1.14] - 2026-06-13

### Added
- New package: the `TaskDag` — topological order (Kahn), ready/blocked tracking, retry/rework helpers, JSON persistence and crash-recovery (`toJSON`/`fromJSON`/`resetTransient`) — extracted from `@kolisachint/hooteams-orchestrator` into this dependency-free foundation layer (its only import is the `AgentMessage` type from `@kolisachint/hoocode-agent-core`). Re-exported from the orchestrator barrel, so existing consumers are unaffected.
- Immutable node snapshots: accessors (`get`/`all`/`ready`/`blocked`/`resetToIdle`/`add`) return frozen copies with their `deps`/`results` arrays sliced, so callers can never mutate internal node state through a live reference (a write throws in strict mode, and array splices don't leak back). All node mutation goes through the dag's own methods, including the new `setOutput(id, output)` and `incrementAttempts(id)`. Optional fields are stored canonically — never as explicit `undefined` keys — so a node's serialized shape is stable across `toJSON`/`fromJSON` round trips (`add` omits an unset `retries`; `setOutput(undefined)`/`markDone()`/`resetToIdle` remove `output`/`results` rather than blanking them). `ready`/`blocked`/`isComplete` read internal state directly instead of snapshotting the whole graph on every call.
