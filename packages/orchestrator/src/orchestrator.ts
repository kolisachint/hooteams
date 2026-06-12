import type { TeamChannel } from "./channel.js";
import type { TaskDag } from "./dag.js";
import type { Team } from "./team.js";
import type { TaskNode, TeamEvent } from "./types.js";

/**
 * Drives a TaskDag to completion over a Team: dispatches every ready node to
 * its role's agent, listens on the channel for run completions, marks nodes
 * done with the messages their run produced, and dispatches whatever that
 * unblocked. A role runs one node at a time; further ready nodes for a busy
 * role queue until its current run ends.
 */
export class Orchestrator {
	/** role -> node id currently running on that role's agent. */
	private readonly inFlight = new Map<string, string>();
	/** role -> node ids that were ready while the role's agent was busy. */
	private readonly queued = new Map<string, string[]>();

	constructor(
		private readonly team: Team,
		private readonly dag: TaskDag,
		private readonly channel: TeamChannel,
	) {}

	/**
	 * Dispatch all currently ready nodes and resolve once dag.isComplete() —
	 * every node done, failed, or permanently blocked by a failure.
	 */
	start(): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const settleIfComplete = () => {
				if (!settled && this.dag.isComplete()) {
					settled = true;
					unsubscribe();
					resolve();
				}
			};
			const unsubscribe = this.channel.subscribe((event) => {
				this.onEvent(event);
				settleIfComplete();
			});
			this.dispatch(this.dag.ready());
			settleIfComplete();
		});
	}

	private onEvent(event: TeamEvent): void {
		if (event.type === "agent_end") {
			const taskId = this.inFlight.get(event.role) ?? this.adopt(event.role);
			if (!taskId) return;
			this.inFlight.delete(event.role);
			const last = event.messages[event.messages.length - 1];
			let newlyReady: TaskNode[] = [];
			if (last?.role === "assistant" && last.errorMessage) {
				this.dag.markFailed(taskId);
			} else {
				newlyReady = this.dag.markDone(taskId, event.messages);
			}
			this.dispatchNextQueued(event.role);
			this.dispatch(newlyReady);
		} else if (event.type === "team_error") {
			const taskId = this.inFlight.get(event.role);
			if (!taskId) return;
			this.inFlight.delete(event.role);
			this.dag.markFailed(taskId);
			this.dispatchNextQueued(event.role);
		}
	}

	/**
	 * Map an untracked run to its dag node: a node for this role that someone
	 * else marked running (e.g. spawn_agent with taskId + an immediate task).
	 */
	private adopt(role: string): string | undefined {
		return this.dag
			.all()
			.find((node) => node.role === role && node.status !== "idle" && node.status !== "done" && node.status !== "error")?.id;
	}

	private dispatch(nodes: TaskNode[]): void {
		for (const node of nodes) {
			if (this.inFlight.has(node.role)) {
				const queue = this.queued.get(node.role) ?? [];
				queue.push(node.id);
				this.queued.set(node.role, queue);
				continue;
			}
			this.dispatchNode(node);
		}
	}

	private dispatchNextQueued(role: string): void {
		if (this.inFlight.has(role)) return;
		const next = this.queued.get(role)?.shift();
		if (next) {
			const node = this.dag.get(next);
			if (node) this.dispatchNode(node);
		}
	}

	private dispatchNode(node: TaskNode): void {
		this.dag.markRunning(node.id);
		this.inFlight.set(node.role, node.id);
		const agent = this.team.get(node.role);
		if (agent?.state.isStreaming) {
			// We are inside the previous run's agent_end settlement: the agent
			// still reports streaming, so a steer now would queue a message the
			// finished run never drains. Steer once the run fully settles.
			void agent.waitForIdle().then(() => this.steerNode(node));
			return;
		}
		this.steerNode(node);
	}

	private steerNode(node: TaskNode): void {
		try {
			this.team.steer(node.role, node.id);
		} catch (err) {
			this.inFlight.delete(node.role);
			this.dag.markFailed(node.id);
			this.channel.publish({
				type: "team_error",
				error: err instanceof Error ? err.message : String(err),
				role: node.role,
				agentId: this.channel.agentId(node.role) ?? "",
				ts: Date.now(),
			});
			this.dispatchNextQueued(node.role);
		}
	}
}
