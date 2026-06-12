// Session primitives re-exported so hosts (apps/server, embedders) can run a
// TeamOrchestrator without depending on @kolisachint/hoocode-agent-core directly.
export { InMemorySessionRepo, JsonlSessionRepo, Session, toSession } from "@kolisachint/hoocode-agent-core";
// Model lookup re-exported so hosts (apps/cli plan mode, embedders) can pick a
// planner model without depending on @kolisachint/hoocode-ai directly.
export { getModel } from "@kolisachint/hoocode-ai";
export { ApprovalRegistry, askOptions } from "./ask-options.js";
export type { ApprovalRequest } from "./ask-options.js";
export { createHoocodeAuth, defaultAuthPath } from "./auth.js";
export type { AuthCredential, AuthFileData, GetApiKey, HoocodeAuthOptions } from "./auth.js";
export { REPLAY_BUFFER_SIZE, TeamChannel } from "./channel.js";
export type { Subscribable, TeamEventListener } from "./channel.js";
export { TaskDag } from "./dag.js";
export type { TaskNodeInput } from "./dag.js";
export { createNodeHarnessFactory, createValidatorAgent, HITL_SYSTEM_PROMPT, VALIDATOR_PROTOCOL } from "./node-harness.js";
export type { NodeHarnessFactoryOptions, ValidatorAgentOptions } from "./node-harness.js";
export { Orchestrator } from "./orchestrator.js";
export {
	createDelegateTaskTool,
	createPlanDelegateTaskTool,
	createPlanSpawnAgentTool,
	createSpawnAgentTool,
	Planner,
	PLANNER_ROLE,
} from "./planner.js";
export type { PlanBuffer, PlannedTask, PlannerOptions } from "./planner.js";
export { Team } from "./team.js";
export type { TeamOptions } from "./team.js";
export { APPROVAL_MARKER, extractMessageText, GOAL_UNMET_MARKER, TeamOrchestrator } from "./team-orchestrator.js";
export type { NodeHandle, NodeHarness, RunValidator, TeamOrchestratorOptions } from "./team-orchestrator.js";
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
