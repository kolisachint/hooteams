# Changelog

## [Unreleased]

### Added
- Model **tiers** for planner-spawned roles, mirroring hoocode's `settings.json` `modelCategories`. A `spawn_agent` `model` may now be a tier — `fast`, `standard`, or `capable` — instead of a concrete id. A tier is provider-agnostic: it resolves through the team's configured `modelCategories` to the same concrete, provider-correct id hoocode itself would use, so the planner (an LLM) can pick *how capable* a worker needs to be without ever authoring a provider-specific model string — which is the spelling it gets wrong. This retires the dash/dot mismatch class at the root rather than guarding it. An unconfigured tier is a no-op that falls back to the team default model (hoocode's `resolveModelCategory` semantic); a tier that resolves to nothing and has no default is rejected at plan time with a tier-specific message. New module `model-categories.ts` (`MODEL_CATEGORIES`, `ModelCategory`, `ModelCategories`, `isModelCategory`, `resolveModelCategory`) and `discoverModelCategories()` (reads the same hoocode `settings.json` as `discoverHoocodeDefaults`). `RoleDefaults` gains `modelCategories`; the CLI plan path and the server's per-run-role backfill both populate it. The `spawn_agent` `model` param description now steers the planner toward tiers.

### Fixed
- Planner role inheritance now treats provider and model as an atomic pair. The planner is an LLM that routinely guesses a model id in one provider's spelling (e.g. anthropic's dashed `claude-sonnet-4-5`) while omitting the provider. `applyRoleDefaults` previously inherited the team's default provider but kept that guessed id, so a team on `github-copilot` (which spells the model `claude-sonnet-4.5`, with a dot) got a role pinned to a provider/model mismatch that `getModel()`'s exact lookup missed, killing the worker on dispatch with an unknown-model error. Now, when the planner names no provider it has no provider context for its guess, so **both** the provider and the model are inherited from the team defaults; an explicitly named provider still keeps the planner's model id. `createSpawnAgentTool`/`createPlanSpawnAgentTool` also report the resolved model rather than the raw guess. `applyRoleDefaults` is now exported so hosts can reuse it instead of re-implementing the independent (and bug-prone) form — the server's per-run-role backfill (`withDefaults`) now does exactly that, closing the same mismatch on the path that runs a serialized plan. The behavior deliberately diverges from `validateConfig()`, which keeps independent inheritance for *static*, human-authored roles where an explicit `model` with no `provider` is an intentional pairing.
- Dry-run planning now validates each planned role's resolved model via `getModel()` at plan time and throws a tool error (which the planner re-plans against) instead of recording an unresolvable model that only fails when the serialized plan is later dispatched. The live spawn path already failed fast in `Team.register`; this brings the dry-run/plan path to parity.

## [0.1.35] - 2026-06-20

## [0.1.34] - 2026-06-20

## [0.1.33] - 2026-06-19

## [0.1.32] - 2026-06-19

## [0.1.31] - 2026-06-18

## [0.1.30] - 2026-06-18

### Added
- Spawn policy: a capability ceiling on the agents the planner spawns at runtime via `spawn_agent`. The planner is an LLM, so its spawn requests are untrusted; the policy is **restrictive by default** — MCP servers (`mcpConfigPath`) are denied and a worker's `cwd` is confined to the project root (`process.cwd()`) unless a host explicitly opens them. A violating spawn throws, surfacing the reason to the planner as a tool error so it can re-plan within bounds; nothing is spawned. Static, human-authored roles in the team config are trusted and bypass the policy — it governs only the dynamic, tool-driven path. New exports `enforceSpawnPolicy`, `resolveSpawnPolicy`, and the `SpawnPolicy`/`SpawnRequest` types; `createSpawnAgentTool` and `createPlanSpawnAgentTool` take an optional policy, and `PlannerOptions` gains `spawnPolicy`.
- Per-node run timeout: `TaskNode.timeoutMs` (surfaced on `spawn_agent`'s `timeoutMs` param and `StartRunTask`) caps the wall-clock time of a single dispatch. On overrun the orchestrator aborts the agent — via a new optional `NodeHarness.abort()`, wired by `createNodeHarnessFactory` to the same `Agent.abort()` `Team.kill` uses, so the run actually stops consuming tokens — and settles the attempt as a failure, which the node's `retries` then handle like any other failed run. Unset or `<= 0` means no timeout.

## [0.1.29] - 2026-06-18

## [0.1.28] - 2026-06-18

## [0.1.27] - 2026-06-18

### Fixed
- Models are now resolved via the new `resolveTeamModel(provider, modelId, authPath?)` instead of the raw static `getModel()`. When the provider has an `oauth` entry in `auth.json`, its OAuth provider's `modifyModels()` is applied to pick up the corrected `baseUrl` — matching what the base hoocode agent does. This fixes `github-copilot` business/enterprise accounts behind a corporate proxy, which previously kept the hardcoded `https://api.individual.githubcopilot.com` and failed every call with `403 Access Denied`; the host is now derived from the OAuth token's `proxy-ep` (e.g. `proxy.business.githubcopilot.com` -> `api.business.githubcopilot.com`). Applied in `Team`, `createValidatorAgent`, `createNodeHarnessFactory`, and `Planner`. New export `resolveTeamModel`.

### Changed
- `runPlanner` (CLI plan mode) falls back to the team config's `defaults.provider`/`defaults.model` when `--provider`/`--model` aren't passed, instead of hardcoding `anthropic`/`claude-sonnet-4-5`.

## [0.1.26] - 2026-06-17

## [0.1.25] - 2026-06-17

### Added
- Role system prompts are now built with hoocode's own machinery (`@kolisachint/hoocode-agent`) instead of passing the raw `systemPrompt` through. Each role's prompt rides on hoocode's coding-assistant base via `appendSystemPrompt`, so it gains the Available-tools list (driven by the node's actual tools) and guidelines, plus project context and skills loaded from the role's `cwd` with hoocode's published `loadProjectContextFiles`/`loadSkills` loaders — re-implementing those would drift from CLI behavior. hooteams' HITL protocol is still appended last. New exports: `buildRoleSystemPrompt`, `buildSystemPromptAvailable`, the `RolePromptInputs`/`HoocodePromptApi` types, and re-exports of hoocode's `loadProjectContextFiles`, `loadSkills`, and `getAgentDir`.
- `RoleConfig` gains optional `appendSystemPrompt` (appendix after the role prompt), `promptGuidelines` (extra guideline bullets), `skillPaths` (extra skill directories beyond hoocode's defaults), and `category` (cosmetic grouping label).
- `createNodeHarnessFactory` accepts `rules` (an array of `{ path, content }` context files) that are injected into every role's system prompt after hoocode's discovered project context — the seam the server uses for `.agents/teams/rules/**`. `buildRoleSystemPrompt` accepts the matching `extraContextFiles` input.
- `Planner` accepts `availableRoles`: when given the configured team, a roster of each role's `category`, model, and one-line brief is appended to the planner prompt so it routes tasks to the right existing agent by category tier instead of spawning new ones blind. New export `formatRoster`.
- New dependency `@kolisachint/hoocode-agent` (`^0.4.67`); `@kolisachint/hoocode-agent-core` and `@kolisachint/hoocode-ai` bumped to `^0.4.67` across the workspace to keep a single resolved version. The `buildSystemPrompt` call is feature-detected so the package can be consumed even if a host pins an older release that predates the export.

## [0.1.24] - 2026-06-16

## [0.1.23] - 2026-06-16

## [0.1.22] - 2026-06-16

## [0.1.21] - 2026-06-14

## [0.1.20] - 2026-06-14

## [0.1.19] - 2026-06-14

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
