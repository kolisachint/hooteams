import type { AgentMessage } from "@kolisachint/hoocode-agent-core";

export type { AgentMessage };

/** Coarse per-agent status derived from the event stream. */
export type AgentStatus = "idle" | "thinking" | "streaming" | "tool" | "done" | "error" | "paused";

/** One unit of work in the team DAG, executed by the agent registered under `role`. */
export interface TaskNode {
	id: string;
	role: string;
	/** Ids of nodes that must reach "done" before this node becomes ready. */
	deps: string[];
	status: AgentStatus;
	/** Messages produced by the node's run, recorded by markDone. */
	results?: AgentMessage[];
	/**
	 * Final assistant text of the node's run, recorded on completion and
	 * injected into the prompts of nodes that depend on this one.
	 */
	output?: string;
	/** Extra dispatch attempts the node gets after a failed run. Default 0. */
	retries?: number;
	/** Failed attempts consumed so far; set by the orchestrator. */
	attempts?: number;
}

/** Shape of TaskDag.toJSON(), as persisted in "dag_state" session entries. */
export type SerializedDag = Record<string, TaskNode>;
