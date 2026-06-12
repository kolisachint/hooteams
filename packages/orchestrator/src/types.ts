import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@kolisachint/hoocode-agent-core";

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

/**
 * The single wire format every consumer (bridge, canvas, CLI attach) sees:
 * a hoocode AgentEvent tagged with which team member produced it, plus
 * team-level synthetic events like "team_error".
 */
export type TeamEvent =
	| (AgentEvent & {
			role: string;
			agentId: string;
			ts: number;
	  })
	| TeamErrorEvent;

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
}

export type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel };
