# Changelog

## [0.1.18] - 2026-06-14

## [0.1.17] - 2026-06-14

## [0.1.16] - 2026-06-14

## [0.1.15] - 2026-06-13

## [0.1.14] - 2026-06-13

### Changed
- Extracted the `TaskDag` (and the `TaskNode`/`AgentStatus`/`SerializedDag` types) into a new dependency-free `@kolisachint/hooteams-dag` package, the foundation layer of the dependency stack (`dag ← orchestrator ← bridge ← server ← cli`). `TaskDag`, `TaskNodeInput`, and the moved types are re-exported from this package's barrel, so the public API is unchanged. New dependency: `@kolisachint/hooteams-dag`.

### Added
- New `TeamOrchestratorOptions` hooks: `prepareTaskPrompt(node, basePrompt)` is the last chance to reshape a node's prompt (after task prompt + dependency outputs + memory bootstrap are composed) before dispatch; `afterTaskSettle(node, status)` observes every node as it settles done/error (output included). Both are best-effort and decoupled from the run lifecycle — `prepareTaskPrompt` failures settle the node as errored, `afterTaskSettle` throws/rejections are swallowed.
- Immutable dag snapshots and the explicit `setOutput`/`incrementAttempts` mutators they require (see `@kolisachint/hooteams-dag`); the orchestrator now routes its node-output and retry-count writes through them.
- Run-level failure handling: an unexpected fault in the synchronous dispatch path now drives the full failure lifecycle (`team_error` + `run_end` "failed" + final dag snapshot + `dag_failed`) instead of rejecting or hanging — `run()` still never rejects.
- Fake-first testing utilities: `FakeNodeHarness` (a scripted, deterministic `NodeHarness` stand-in — `queue()` assistant text or an `Error`, defaults to echoing the prompt) and `fakeHarnessFactory(script?)` (a ready-made `createHarness` returning one fake per node), so dag/orchestrator tests run with no API key or real model.

## [0.1.13] - 2026-06-12

### Added
- Agent memory & shared knowledge store: `TeamMemory` is a project-scoped (not per-run) JSON store under `~/.hooteams/memory`, shared by every agent on the team and surviving across runs. Agents read/write it through the new `memory_read`/`memory_write` tools (`createMemoryReadTool`/`createMemoryWriteTool`); `TeamOrchestratorOptions.memory` (the new `RunMemory` hook) auto-records every settled task's output at run end and injects prior-run context (`bootstrapContext`) into root task prompts, so new runs on the same project start from what earlier runs learned. Store operations are serialized and saves are atomic (temp file + rename); helpers `projectKeyFromCwd()` and `defaultMemoryRoot()` are exported.
- Structured agent-to-agent messaging: `ask_agent(role, question)` (`createAskAgentTool`) is the request-response counterpart to fire-and-forget `delegate_task` — the question is steered into the target agent and the tool blocks until the target's next `agent_end`, returning its final reply text. Asking your own role is rejected (it would deadlock), unknown roles list the available ones, and an optional `timeoutSeconds` (default 120) bounds the wait. The bare `askAgent()` promise helper is exported for hosts. The live `Planner` and every `createNodeHarnessFactory` node agent (when `team` is provided) get the tool automatically.
- `NodeHarnessFactoryOptions.memory` and `PlannerOptions.memory` wire the memory tools into node agents and the live planner.

## [0.1.12] - 2026-06-12

### Added
- Inter-agent result passing: `TaskNode.output` records the final assistant text of a completed node, and the orchestrator appends the outputs of a node's dependencies to its task prompt — results now chain through the dag instead of every task running siloed.
- Error recovery stack: `TaskNode.retries`/`attempts` and `TaskDag.resetToIdle()` give failed nodes local re-dispatch (persisted as `task_retry` session entries and surfaced as a new additive `task_retried` TeamEvent), and `TeamOrchestratorOptions.onTaskFailed` fires when retries are exhausted so hosts can escalate structurally (e.g. steer the failure summary to a planner agent).
- Plan-before-execute: `new Planner({ dryRun: true })` swaps `spawn_agent`/`delegate_task` for buffer-mode twins (`createPlanSpawnAgentTool`, `createPlanDelegateTaskTool`) that record a `PlanBuffer` of role configs + tasks instead of spawning anything. `spawn_agent` also gained optional `deps` and `retries` parameters (live mode forwards them to the dag).
- Goal-completion validation: `TeamOrchestratorOptions.validator` runs a validation pass after the dag completes cleanly — `GOAL_MET` settles the run; `GOAL_UNMET: <reason> | <taskId>` (see `GOAL_UNMET_MARKER`) resets that task to idle and re-runs it, up to `maxRounds` (default 2) passes before an unmet verdict fails the run. `createValidatorAgent()` builds the validate function from a system prompt + model; `VALIDATOR_PROTOCOL` documents the verdict shape; `TeamConfig.validator` carries the prompt in config form.
- Exports: `extractMessageText()`, `GOAL_UNMET_MARKER`, `RunValidator`, `PlanBuffer`/`PlannedTask`, `TaskRetriedEvent`, `ValidatorAgentOptions`, and a `getModel` re-export from `@kolisachint/hoocode-ai` for hosts picking a planner model.

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
