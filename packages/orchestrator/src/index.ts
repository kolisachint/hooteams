// Session primitives re-exported so hosts (apps/server, embedders) can run a
// TeamOrchestrator without depending on @kolisachint/hoocode-agent-core directly.
export { InMemorySessionRepo, JsonlSessionRepo, Session, toSession } from "@kolisachint/hoocode-agent-core";
// Model lookup re-exported so hosts (apps/cli plan mode, embedders) can pick a
// planner model without depending on @kolisachint/hoocode-ai directly.
export { getModel } from "@kolisachint/hoocode-ai";
export { ApprovalRegistry, askOptions } from "./ask-options.js";
export type { ApprovalRequest } from "./ask-options.js";
export {
	createHoocodeAuth,
	DEFAULT_MODEL,
	DEFAULT_PROVIDER,
	defaultAuthPath,
	discoverHoocodeDefaults,
	hoocodeAgentDir,
	resolveTeamModel,
} from "./auth.js";
export type { AuthCredential, AuthFileData, GetApiKey, HoocodeAuthOptions } from "./auth.js";
export { REPLAY_BUFFER_SIZE, TeamChannel } from "./channel.js";
// hoocode's published prompt loaders, re-exported so hosts can reuse them without
// depending on @kolisachint/hoocode-agent directly.
export { getAgentDir, loadProjectContextFiles, loadSkills } from "@kolisachint/hoocode-agent";
export { buildRoleSystemPrompt, buildSystemPromptAvailable } from "./role-prompt.js";
export type { HoocodePromptApi, RolePromptInputs } from "./role-prompt.js";
export type { Subscribable, TeamEventListener } from "./channel.js";
export { TaskDag } from "@kolisachint/hooteams-dag";
export type { TaskNodeInput } from "@kolisachint/hooteams-dag";
export { createBoardTools, createMemoryReadTool, createMemoryWriteTool, defaultMemoryRoot, projectKeyFromCwd, TeamMemory } from "./memory.js";
export type { MemoryEntry, MemoryTaskRecord, TeamMemoryOptions } from "./memory.js";
export { createNodeHarnessFactory, createValidatorAgent, HITL_SYSTEM_PROMPT, VALIDATOR_PROTOCOL } from "./node-harness.js";
export type { NodeHarnessFactoryOptions, ValidatorAgentOptions } from "./node-harness.js";
export { Orchestrator } from "./orchestrator.js";
export {
	applyRoleDefaults,
	askAgent,
	createAskAgentTool,
	createDelegateTaskTool,
	createPlanDelegateTaskTool,
	createPlanSpawnAgentTool,
	createSpawnAgentTool,
	formatRoster,
	Planner,
	PLANNER_ROLE,
} from "./planner.js";
export type { AskAgentOptions, PlanBuffer, PlannedTask, PlannerOptions, RoleDefaults } from "./planner.js";
export { enforceSpawnPolicy, resolveSpawnPolicy } from "./spawn-policy.js";
export type { SpawnPolicy, SpawnRequest } from "./spawn-policy.js";
export { Team } from "./team.js";
export type { TeamOptions } from "./team.js";
export { FakeNodeHarness, fakeHarnessFactory } from "./testing.js";
export { APPROVAL_MARKER, extractMessageText, GOAL_UNMET_MARKER, TeamOrchestrator } from "./team-orchestrator.js";
export type { NodeHandle, NodeHarness, RunMemory, RunValidator, TeamOrchestratorOptions } from "./team-orchestrator.js";
export type {
	AgentEvent,
	AgentMessage,
	AgentStatus,
	DagSettledEvent,
	RoleConfig,
	SerializedDag,
	TaskFinishedEvent,
	TaskNode,
	TaskPausedEvent,
	TaskResumedEvent,
	TaskRetriedEvent,
	TaskStartedEvent,
	TeamConfig,
	TeamErrorEvent,
	TeamEvent,
	ThinkingLevel,
	TraceApproval,
	TraceRun,
	TraceTask,
} from "./types.js";
