# Changelog

## [Unreleased]

## [0.1.11] - 2026-06-12

## [0.1.10] - 2026-06-12

### Added
- `TeamOrchestrator`: harness-per-node dag execution with a `maxConcurrent` slot pool, human-in-the-loop pauses via the `AWAITING_APPROVAL: question | opt1, opt2` marker, `resume(taskId, option)`, crash recovery with `restoreFromSession()`, and audit trails with `buildTrace()`. All run state persists to a hoocode `Session` through a serialized write queue. This is the path forward for team execution; `Orchestrator` remains for the planner flow.
- `ApprovalRegistry` + `askOptions()`: instance-scoped, first-answer-wins approval gates with optional timeout/default, persisted as `approval_request`/`approval_response` session entries (plus a `display: true` message any attached hoocode TUI renders).
- `TaskDag.markPaused()` and `TaskDag.resetTransient()`; `"paused"` added to `AgentStatus`.
- New synthetic `TeamEvent` variants (additive, wire-compatible): `task_started`, `task_finished`, `task_paused`, `task_resumed`, `dag_complete`, `dag_failed`.
- Trace types: `TraceRun`, `TraceTask`, `TraceApproval`, `SerializedDag`.
- `createNodeHarnessFactory()`: a `TeamOrchestratorOptions.createHarness` backed by real `AgentHarness` instances — one per dag node, each with its own `JsonlSessionRepo` session named `<runId>-<taskId>` (so a restored run's resume reopens the node's conversation), the role's tools/model/credentials, and `HITL_SYSTEM_PROMPT` (the `AWAITING_APPROVAL` protocol) appended to its system prompt.
- `TeamOrchestrator.isSettled`: true once the dag fully settled, for hosts gating "one run at a time".

### Changed
- `@kolisachint/hoocode-agent-core` dependency raised to `^0.4.49` (AgentHarness/Session APIs).

## [0.1.9] - 2026-06-12

## [0.1.8] - 2026-06-11

## [0.1.7] - 2026-06-11

## [0.1.6] - 2026-06-11

## [0.1.5] - 2026-06-11

## [0.1.4] - 2026-06-11

## [0.1.3] - 2026-06-11

## [0.1.2] - 2026-06-11

## [0.1.1] - 2026-06-11

### Added
- Initial release of hooteams-orchestrator package

### Changed
- 

### Fixed
- 
