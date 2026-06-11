import type { AgentEvent, AgentMessage, ThinkingLevel } from "@kolisachint/hoocode-agent-core";

/**
 * The single wire format every consumer (bridge, canvas, CLI attach) sees:
 * a hoocode AgentEvent tagged with which team member produced it.
 */
export type TeamEvent = AgentEvent & {
	role: string;
	agentId: string;
	ts: number;
};

/** Coarse per-agent status derived from the event stream. */
export type AgentStatus = "idle" | "thinking" | "streaming" | "tool" | "done" | "error";

/** One unit of work in the team DAG, executed by the agent registered under `role`. */
export interface TaskNode {
	id: string;
	role: string;
	/** Ids of nodes that must reach "done" before this node becomes ready. */
	deps: string[];
	status: AgentStatus;
	/** Messages produced by the node's run, recorded by markDone. */
	results?: AgentMessage[];
}

/** Configuration for a single team member. */
export interface RoleConfig {
	role: string;
	systemPrompt: string;
	/** Model id, resolved via @kolisachint/hoocode-ai getModel(). */
	model: string;
	/** Model provider for getModel(). Defaults to "anthropic". */
	provider?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface TeamConfig {
	roles: RoleConfig[];
	maxConcurrent?: number;
}

export type { AgentEvent, AgentMessage, ThinkingLevel };
