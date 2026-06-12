import type { AgentMessage, AgentStatus, TaskNode } from "./types.js";

export interface TaskNodeInput {
	id: string;
	role: string;
	deps?: string[];
}

/**
 * Dependency graph of team tasks. Nodes start "idle", become dispatchable when
 * every dependency is "done", and markDone() reports which nodes that
 * completion unblocked so the orchestrator can dispatch them next.
 */
export class TaskDag {
	private readonly nodes = new Map<string, TaskNode>();

	add(input: TaskNodeInput): TaskNode {
		if (this.nodes.has(input.id)) {
			throw new Error(`Task "${input.id}" already exists`);
		}
		const node: TaskNode = { id: input.id, role: input.role, deps: input.deps?.slice() ?? [], status: "idle" };
		this.nodes.set(input.id, node);
		return node;
	}

	get(id: string): TaskNode | undefined {
		return this.nodes.get(id);
	}

	all(): TaskNode[] {
		return [...this.nodes.values()];
	}

	/** Kahn's algorithm. Throws on unknown deps or cycles. */
	topologicalOrder(): string[] {
		const inDegree = new Map<string, number>();
		const dependents = new Map<string, string[]>();
		for (const node of this.nodes.values()) {
			inDegree.set(node.id, node.deps.length);
			for (const dep of node.deps) {
				if (!this.nodes.has(dep)) {
					throw new Error(`Task "${node.id}" depends on unknown task "${dep}"`);
				}
				const list = dependents.get(dep) ?? [];
				list.push(node.id);
				dependents.set(dep, list);
			}
		}
		const queue = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
		const order: string[] = [];
		while (queue.length > 0) {
			const id = queue.shift()!;
			order.push(id);
			for (const dependent of dependents.get(id) ?? []) {
				const remaining = inDegree.get(dependent)! - 1;
				inDegree.set(dependent, remaining);
				if (remaining === 0) queue.push(dependent);
			}
		}
		if (order.length !== this.nodes.size) {
			const stuck = [...inDegree.entries()]
				.filter(([, degree]) => degree > 0)
				.map(([id]) => id)
				.join(", ");
			throw new Error(`Task graph has a cycle involving: ${stuck}`);
		}
		return order;
	}

	/** Nodes that are idle and whose dependencies are all done. */
	ready(): TaskNode[] {
		return this.all().filter(
			(node) => node.status === "idle" && node.deps.every((dep) => this.nodes.get(dep)?.status === "done"),
		);
	}

	/** Mark a node as dispatched so ready() stops returning it. */
	markRunning(id: string, status: AgentStatus = "streaming"): void {
		const node = this.require(id);
		node.status = status;
	}

	/**
	 * Record a node's completion and the messages its agent produced.
	 * Returns the nodes this completion made ready, in insertion order.
	 */
	markDone(id: string, results?: AgentMessage[]): TaskNode[] {
		const node = this.require(id);
		const readyBefore = new Set(this.ready().map((other) => other.id));
		node.status = "done";
		node.results = results;
		return this.ready().filter((other) => !readyBefore.has(other.id));
	}

	markFailed(id: string): void {
		this.require(id).status = "error";
	}

	/**
	 * Mark a running node as waiting on a human approval. Paused nodes are
	 * neither ready nor complete, so the dag stays open until they resume
	 * (markRunning) and eventually settle.
	 */
	markPaused(id: string): void {
		this.require(id).status = "paused";
	}

	/** Nodes that can never run because a transitive dependency failed. */
	blocked(): TaskNode[] {
		const failed = new Set(this.all().filter((node) => node.status === "error").map((node) => node.id));
		if (failed.size === 0) return [];
		const blocked: TaskNode[] = [];
		for (const id of this.topologicalOrder()) {
			const node = this.nodes.get(id)!;
			if (node.status === "error") continue;
			if (node.deps.some((dep) => failed.has(dep))) {
				failed.add(node.id);
				blocked.push(node);
			}
		}
		return blocked;
	}

	/** True when every node is done, failed, or permanently blocked. */
	isComplete(): boolean {
		const blockedIds = new Set(this.blocked().map((node) => node.id));
		return this.all().every(
			(node) => node.status === "done" || node.status === "error" || blockedIds.has(node.id),
		);
	}

	/**
	 * Plain-object snapshot of the graph keyed by node id, safe to
	 * JSON.stringify. The caller decides where to persist it.
	 */
	toJSON(): Record<string, TaskNode> {
		const snapshot: Record<string, TaskNode> = {};
		for (const [id, node] of this.nodes) {
			snapshot[id] = { ...node, deps: node.deps.slice() };
		}
		return snapshot;
	}

	/**
	 * Reset nodes caught mid-run (thinking/streaming/tool) back to idle so a
	 * restored dag re-dispatches them. Paused nodes are left paused — their
	 * approval gate is re-surfaced instead of re-running them. Returns the
	 * nodes that were reset.
	 */
	resetTransient(): TaskNode[] {
		const reset: TaskNode[] = [];
		for (const node of this.nodes.values()) {
			if (node.status === "thinking" || node.status === "streaming" || node.status === "tool") {
				node.status = "idle";
				reset.push(node);
			}
		}
		return reset;
	}

	/** Rebuild a dag from a toJSON() snapshot, preserving statuses and results. */
	static fromJSON(snapshot: Record<string, TaskNode>): TaskDag {
		const dag = new TaskDag();
		for (const node of Object.values(snapshot)) {
			dag.nodes.set(node.id, { ...node, deps: node.deps?.slice() ?? [] });
		}
		return dag;
	}

	private require(id: string): TaskNode {
		const node = this.nodes.get(id);
		if (!node) {
			throw new Error(`Unknown task "${id}"`);
		}
		return node;
	}
}
