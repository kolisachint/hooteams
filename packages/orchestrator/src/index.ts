// Session primitives re-exported so hosts (apps/server, embedders) can run a
// TeamOrchestrator without depending on @kolisachint/hoocode-agent-core directly.
export { InMemorySessionRepo, JsonlSessionRepo, Session, toSession } from "@kolisachint/hoocode-agent-core";
export { ApprovalRegistry, askOptions } from "./ask-options.js";
export type { ApprovalRequest } from "./ask-options.js";
export { createHoocodeAuth, defaultAuthPath } from "./auth.js";
export type { AuthCredential, AuthFileData, GetApiKey, HoocodeAuthOptions } from "./auth.js";
export { REPLAY_BUFFER_SIZE, TeamChannel } from "./channel.js";
export type { Subscribable, TeamEventListener } from "./channel.js";
export { TaskDag } from "./dag.js";
export type { TaskNodeInput } from "./dag.js";
export { createNodeHarnessFactory, HITL_SYSTEM_PROMPT } from "./node-harness.js";
export type { NodeHarnessFactoryOptions } from "./node-harness.js";
export { Orchestrator } from "./orchestrator.js";
export { createDelegateTaskTool, createSpawnAgentTool, Planner, PLANNER_ROLE } from "./planner.js";
export type { PlannerOptions } from "./planner.js";
export { Team } from "./team.js";
export type { TeamOptions } from "./team.js";
export { APPROVAL_MARKER, TeamOrchestrator } from "./team-orchestrator.js";
export type { NodeHandle, NodeHarness, TeamOrchestratorOptions } from "./team-orchestrator.js";
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
	TaskStartedEvent,
	TeamConfig,
	TeamErrorEvent,
	TeamEvent,
	ThinkingLevel,
	TraceApproval,
	TraceRun,
	TraceTask,
} from "./types.js";
