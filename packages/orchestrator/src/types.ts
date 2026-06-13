import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@kolisachint/hoocode-agent-core";
import type { AgentStatus, SerializedDag, TaskNode } from "@kolisachint/hooteams-dag";

/**
 * Synthetic event published by the Team when starting or resuming an agent's
 * run fails outside the run itself (where no AgentEvent would ever surface it).
 */
export interface TeamErrorEvent {
	type: "team_error";
	error: string;
	role: string;
	agentId: string;
	ts: number;
}

/** A task hit an approval gate and is waiting for a human to pick an option. */
export interface TaskPausedEvent {
	type: "task_paused";
	taskId: string;
	role: string;
	agentId: string;
	question: string;
	options: string[];
	ts: number;
}

/** A paused task received its answer and is running again. */
export interface TaskResumedEvent {
	type: "task_resumed";
	taskId: string;
	role: string;
	agentId: string;
	chosenOption: string;
	ts: number;
}

/** A dag node was dispatched to an agent. */
export interface TaskStartedEvent {
	type: "task_started";
	taskId: string;
	role: string;
	agentId: string;
	ts: number;
}

/**
 * A settled node is being re-dispatched: a failed run consuming one of its
 * retries, or a validator verdict sending a "done" task back for rework.
 */
export interface TaskRetriedEvent {
	type: "task_retried";
	taskId: string;
	role: string;
	agentId: string;
	/** Failed attempts consumed so far, counting this one. */
	attempt: number;
	/** What sent the task back: the run error or the validator's reason. */
	error: string;
	ts: number;
}

/** A dag node settled as done or error. */
export interface TaskFinishedEvent {
	type: "task_finished";
	taskId: string;
	role: string;
	agentId: string;
	status: "done" | "error";
	ts: number;
}

/** The whole dag settled. `role` is always "orchestrator"; `agentId` is the run id. */
export interface DagSettledEvent {
	type: "dag_complete" | "dag_failed";
	runId: string;
	role: string;
	agentId: string;
	ts: number;
}

/**
 * The single wire format every consumer (bridge, canvas, CLI attach) sees:
 * a hoocode AgentEvent tagged with which team member produced it, plus
 * team-level synthetic events like "team_error". Extend this union additively
 * only — hoocanvas and hoocode attach consume it over SSE by shape.
 */
export type TeamEvent =
	| (AgentEvent & {
			role: string;
			agentId: string;
			ts: number;
	  })
	| TeamErrorEvent
	| TaskPausedEvent
	| TaskResumedEvent
	| TaskStartedEvent
	| TaskRetriedEvent
	| TaskFinishedEvent
	| DagSettledEvent;

/** Configuration for a single team member. */
export interface RoleConfig {
	role: string;
	systemPrompt: string;
	/** Model id, resolved via @kolisachint/hoocode-ai getModel(). */
	model: string;
	/** Model provider for getModel(). Defaults to "anthropic". */
	provider?: string;
	thinkingLevel?: ThinkingLevel;
	/** Extra tools handed to the agent as-is (programmatic configs only). */
	tools?: AgentTool<any>[];
	/** Prepend hoocode's built-in coding tools (bash/read/edit/write/grep/find/ls), rooted at `cwd`. */
	defaultTools?: boolean;
	/** Path to a standard mcp.json; its servers' tools are appended. Requires Team.spawnAsync(). */
	mcpConfigPath?: string;
	/** Working directory for the agent's tools. Defaults to process.cwd(). */
	cwd?: string;
}

export interface TeamConfig {
	roles: RoleConfig[];
	maxConcurrent?: number;
	/**
	 * System prompt for a goal-completion validator. When set, a validator
	 * agent reviews the goal and every task's output after the dag completes,
	 * and an unmet verdict sends the named task back for rework.
	 */
	validator?: string;
}

/** One approval gate a task went through, reconstructed from session entries. */
export interface TraceApproval {
	question: string;
	options: string[];
	chosenOption?: string;
	requestedAt: number;
	resolvedAt?: number;
}

/** One task's lifecycle, reconstructed from session entries by buildTrace(). */
export interface TraceTask {
	taskId: string;
	role: string;
	/** Session id of the node's own conversation, when the harness factory reported one. */
	sessionId?: string;
	startedAt?: number;
	endedAt?: number;
	status?: AgentStatus;
	approvals: TraceApproval[];
}

/** A whole orchestrator run, reconstructed from session entries by buildTrace(). */
export interface TraceRun {
	runId: string;
	status: "running" | "complete" | "failed";
	startedAt?: number;
	endedAt?: number;
	tasks: TraceTask[];
	/** Last persisted dag snapshot, if any. */
	dag?: SerializedDag;
}

export type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel };
export type { AgentStatus, SerializedDag, TaskNode };
