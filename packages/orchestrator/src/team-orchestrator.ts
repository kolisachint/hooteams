import type { Session } from "@kolisachint/hoocode-agent-core";
import { randomUUID } from "node:crypto";
import { ApprovalRegistry, type ApprovalRequest } from "./ask-options.js";
import type { TeamChannel } from "./channel.js";
import { TaskDag } from "./dag.js";
import type { AgentEvent, AgentMessage, SerializedDag, TaskNode, TeamEvent, TraceRun, TraceTask } from "./types.js";

/**
 * Minimal surface the orchestrator needs from a per-node agent runtime.
 * AgentHarness from @kolisachint/hoocode-agent-core satisfies this; tests
 * pass fakes. Note AgentHarness.steer() throws while idle — the orchestrator
 * only steers mid-run and starts a fresh prompt() otherwise.
 */
export interface NodeHarness {
	prompt(text: string): Promise<unknown>;
	steer(text: string): void;
	subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void;
}

/** What the harness factory hands back for one dag node. */
export interface NodeHandle {
	harness: NodeHarness;
	/** Surfaced as agentId on TeamEvents. Defaults to a random UUID. */
	agentId?: string;
	/** Session id of the node's own conversation, recorded in the run trace. */
	sessionId?: string;
}

export interface TeamOrchestratorOptions {
	/**
	 * Run session owning all orchestrator-level entries (dag snapshots, task
	 * lifecycle, approvals). Node conversations get their own sessions via
	 * createHarness — concurrent harnesses must not share one session, since a
	 * hoocode session is a single-branch tree and parallel appends race the
	 * leaf pointer.
	 */
	session: Session;
	/**
	 * Build the agent runtime for one node. Called once per dispatch; for a
	 * node restored in "paused" state it is called again on resume, and should
	 * reopen the node's persisted session so the conversation context survives.
	 */
	createHarness: (node: TaskNode) => NodeHandle | Promise<NodeHandle>;
	/** Event bus mirrored to SSE consumers. Omit for headless/test runs. */
	channel?: TeamChannel;
	/** Max nodes running at once. Paused nodes release their slot. Default 4. */
	maxConcurrent?: number;
	runId?: string;
	/** Text that starts a node's run. Defaults to the node id (parity with Orchestrator). */
	taskPrompt?: (node: TaskNode) => string;
	/**
	 * When false, the orchestrator opens a deterministic completion gate before
	 * each node settles "done" (human-in-the-loop). Defaults to true (autonomous)
	 * so the library stays backward-compatible; the server/CLI default it to
	 * false so `hooteams start` is HITL by default. See docs/hitl-gates.md.
	 */
	allowAutonomous?: boolean;
}

/**
 * Mid-run approval gate: an agent that needs a human decision ends its
 * message with a line in this shape and stops. The orchestrator pauses the
 * node, surfaces a "task_paused" TeamEvent, and resumes the agent with the
 * chosen option once resume() is called.
 */
export const APPROVAL_MARKER = /^AWAITING_APPROVAL:\s*(.+?)\s*\|\s*(.+)$/m;

/** AgentEvent types mirrored onto the channel (harness-own events are not). */
const MIRRORED_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

interface ActiveNode {
	node: TaskNode;
	harness: NodeHarness;
	agentId: string;
	sessionId?: string;
	unsubscribe: () => void;
	/** Messages of the most recent agent_end, used as the node's results. */
	lastMessages?: AgentMessage[];
	paused: boolean;
	/** True between a prompt() call and its settlement. */
	runActive: boolean;
}

/**
 * Drives a TaskDag with one ephemeral harness per node: dispatches ready
 * nodes concurrently up to maxConcurrent, pauses nodes that hit an
 * AWAITING_APPROVAL gate (releasing their slot), resumes them via resume(),
 * and persists every state change to the run session so a crashed run can be
 * restored with restoreFromSession() and audited with buildTrace().
 *
 * This is the path forward for team execution; the Team/channel-based
 * Orchestrator remains for the planner flow until it migrates.
 */
export class TeamOrchestrator {
	readonly runId: string;
	private readonly approvals = new ApprovalRegistry();
	private readonly session: Session;
	private readonly channel?: TeamChannel;
	private readonly maxConcurrent: number;
	private readonly createHarness: (node: TaskNode) => NodeHandle | Promise<NodeHandle>;
	private readonly taskPrompt: (node: TaskNode) => string;
	private readonly allowAutonomous: boolean;
	private readonly active = new Map<string, ActiveNode>();
	/** Task ids whose current gate is an end-of-task completion gate (vs a marker gate). */
	private readonly completionGates = new Set<string>();
	/** Resumed tasks waiting for a free slot, answer text included. */
	private readonly resumeQueue: { taskId: string; text: string }[] = [];
	/** Gates restored from a previous run, re-surfaced on run(). */
	private restoredApprovals: ApprovalRequest[] = [];
	private slotsInUse = 0;
	private writeChain: Promise<void> = Promise.resolve();
	private settle?: () => void;
	private started = false;
	private finished = false;

	constructor(
		private readonly dag: TaskDag,
		options: TeamOrchestratorOptions,
	) {
		this.session = options.session;
		this.channel = options.channel;
		this.maxConcurrent = options.maxConcurrent ?? 4;
		this.createHarness = options.createHarness;
		this.taskPrompt = options.taskPrompt ?? ((node) => node.id);
		this.allowAutonomous = options.allowAutonomous ?? true;
		this.runId = options.runId ?? randomUUID();
	}

	/**
	 * Dispatch all ready nodes and resolve once the dag is complete — every
	 * node done, failed, or permanently blocked. Never rejects; failures are
	 * recorded on the dag and surfaced as a "dag_failed" event. All session
	 * writes are flushed before this resolves.
	 */
	run(): Promise<void> {
		if (this.started) {
			throw new Error("TeamOrchestrator.run() may only be called once");
		}
		this.started = true;
		this.persist("run_start", { runId: this.runId, ts: Date.now() });
		this.snapshotDag();
		return new Promise<void>((resolve) => {
			this.settle = resolve;
			for (const request of this.restoredApprovals) {
				this.surfacePause(request);
			}
			this.restoredApprovals = [];
			this.fill();
			this.checkSettled();
		});
	}

	/** True once the dag fully settled (every node done, failed, or blocked). */
	get isSettled(): boolean {
		return this.finished;
	}

	/**
	 * Answer a paused task. Returns false when nothing was pending for it —
	 * never paused, or another surface answered first (first answer wins) —
	 * so wire handlers can report a stale answer instead of double-resuming.
	 */
	resume(taskId: string, chosenOption: string, feedback?: string): boolean {
		return this.approvals.resolve(taskId, feedback ? `${chosenOption}\n${feedback}` : chosenOption);
	}

	/** Unanswered approval gates, e.g. to replay to a reconnecting client. */
	pendingApprovals(): ApprovalRequest[] {
		return this.approvals.pendingRequests();
	}

	/** Resolves when every session write issued so far has landed. */
	flush(): Promise<void> {
		return this.writeChain;
	}

	/**
	 * Rebuild an orchestrator from a run session written by a previous (e.g.
	 * crashed) process: the last "dag_state" snapshot becomes the dag, nodes
	 * caught mid-run are reset to idle for re-dispatch, and approval_request
	 * entries without a matching approval_response are re-surfaced as
	 * task_paused events when run() is called.
	 */
	static async restoreFromSession(session: Session, options: Omit<TeamOrchestratorOptions, "session">): Promise<TeamOrchestrator> {
		const entries = await session.getEntries();
		let snapshot: SerializedDag | undefined;
		let runId = options.runId;
		const pending = new Map<string, ApprovalRequest>();
		const completionKinds = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const data = entry.data as Record<string, any> | undefined;
			if (!data) continue;
			switch (entry.customType) {
				case "dag_state":
					snapshot = data.dag as SerializedDag;
					runId ??= data.runId;
					break;
				case "approval_request":
					pending.set(data.taskId, { taskId: data.taskId, question: data.question, options: data.options });
					if (data.kind === "completion") completionKinds.add(data.taskId);
					else completionKinds.delete(data.taskId);
					break;
				case "approval_response":
					pending.delete(data.taskId);
					completionKinds.delete(data.taskId);
					break;
			}
		}
		if (!snapshot) {
			throw new Error("Cannot restore: session has no dag_state entry");
		}
		const dag = TaskDag.fromJSON(snapshot);
		dag.resetTransient();
		const orchestrator = new TeamOrchestrator(dag, { ...options, session, runId });
		orchestrator.restoredApprovals = [...pending.values()].filter((request) => dag.get(request.taskId)?.status === "paused");
		for (const taskId of completionKinds) {
			if (dag.get(taskId)?.status === "paused") orchestrator.completionGates.add(taskId);
		}
		return orchestrator;
	}

	/** Assemble a run's audit trail from the session entries written by run(). */
	static async buildTrace(session: Session, runId?: string): Promise<TraceRun> {
		const entries = await session.getEntries();
		const tasks = new Map<string, TraceTask>();
		const task = (taskId: string, role?: string): TraceTask => {
			let entry = tasks.get(taskId);
			if (!entry) {
				entry = { taskId, role: role ?? "", approvals: [] };
				tasks.set(taskId, entry);
			}
			if (role) entry.role = role;
			return entry;
		};
		const trace: TraceRun = { runId: runId ?? "", status: "running", tasks: [] };
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const data = entry.data as Record<string, any> | undefined;
			if (!data) continue;
			if (runId && data.runId && data.runId !== runId) continue;
			switch (entry.customType) {
				case "run_start":
					trace.runId = trace.runId || data.runId;
					trace.startedAt = data.ts;
					break;
				case "run_end":
					trace.status = data.status;
					trace.endedAt = data.ts;
					break;
				case "dag_state":
					trace.runId = trace.runId || data.runId;
					trace.dag = data.dag;
					break;
				case "task_start": {
					const t = task(data.taskId, data.role);
					t.startedAt = data.ts;
					t.sessionId = data.sessionId;
					break;
				}
				case "task_end": {
					const t = task(data.taskId);
					t.endedAt = data.ts;
					t.status = data.status;
					break;
				}
				case "approval_request":
					task(data.taskId).approvals.push({
						question: data.question,
						options: data.options,
						requestedAt: data.ts,
					});
					break;
				case "approval_response": {
					const open = task(data.taskId).approvals.find((approval) => approval.chosenOption === undefined);
					if (open) {
						open.chosenOption = data.chosenOption;
						open.resolvedAt = data.ts;
					}
					break;
				}
			}
		}
		for (const t of tasks.values()) {
			if (!t.role && trace.dag) t.role = trace.dag[t.taskId]?.role ?? "";
			if (!t.status && trace.dag) t.status = trace.dag[t.taskId]?.status;
		}
		trace.tasks = [...tasks.values()];
		return trace;
	}

	/** Claim slots for resumed tasks first (a human is waiting), then ready nodes. */
	private fill(): void {
		while (this.slotsInUse < this.maxConcurrent && this.resumeQueue.length > 0) {
			const next = this.resumeQueue.shift()!;
			this.slotsInUse++;
			this.resumeNode(next.taskId, next.text);
		}
		for (const node of this.dag.ready()) {
			if (this.slotsInUse >= this.maxConcurrent) break;
			this.slotsInUse++;
			void this.dispatchNode(node, this.taskPrompt(node));
		}
	}

	private async dispatchNode(node: TaskNode, text: string): Promise<void> {
		// Mark before the (possibly async) factory call so a re-entrant fill()
		// can't dispatch the same node twice.
		this.dag.markRunning(node.id);
		try {
			const handle = await this.createHarness(node);
			const active: ActiveNode = {
				node,
				harness: handle.harness,
				agentId: handle.agentId ?? randomUUID(),
				sessionId: handle.sessionId,
				unsubscribe: () => {},
				paused: false,
				runActive: false,
			};
			active.unsubscribe = handle.harness.subscribe((event) => this.onHarnessEvent(active, event));
			this.active.set(node.id, active);
			this.persist("task_start", {
				runId: this.runId,
				taskId: node.id,
				role: node.role,
				agentId: active.agentId,
				sessionId: active.sessionId,
				ts: Date.now(),
			});
			this.publish({ type: "task_started", taskId: node.id, role: node.role, agentId: active.agentId, ts: Date.now() });
			this.startRun(active, text);
		} catch (err) {
			this.settleNode(node.id, true, { error: err });
		}
	}

	private startRun(active: ActiveNode, text: string): void {
		active.runActive = true;
		active.harness.prompt(text).then(
			() => {
				active.runActive = false;
				this.onRunSettled(active);
			},
			(err) => {
				active.runActive = false;
				this.onRunSettled(active, err);
			},
		);
	}

	private onHarnessEvent(active: ActiveNode, event: AgentEvent): void {
		if (MIRRORED_EVENT_TYPES.has(event.type)) {
			this.publish({ ...event, role: active.node.role, agentId: active.agentId, ts: Date.now() });
		}
		if (event.type === "agent_end") {
			active.lastMessages = event.messages;
			return;
		}
		if (event.type === "message_end" && !active.paused && event.message.role === "assistant") {
			const match = APPROVAL_MARKER.exec(this.messageText(event.message));
			if (match) {
				const question = match[1]!.trim();
				const options = match[2]!
					.split(",")
					.map((option) => option.trim())
					.filter(Boolean);
				this.pauseNode(active, question, options);
			}
		}
	}

	private messageText(message: AgentMessage): string {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}

	private pauseNode(active: ActiveNode, question: string, options: string[]): void {
		this.openGate(active, question, options, "marker");
	}

	/**
	 * Open a completion gate before a node settles "done". HITL-active runs route
	 * every clean run end through here so a human can approve or revise the output
	 * without the agent having to emit an AWAITING_APPROVAL marker.
	 */
	private pauseForCompletion(active: ActiveNode): void {
		const question = `Review the output of "${active.node.id}" before it is marked done.`;
		this.openGate(active, question, ["approve", "revise"], "completion");
	}

	/** Shared gate body for marker and completion pauses; frees the node's slot. */
	private openGate(active: ActiveNode, question: string, options: string[], kind: "marker" | "completion"): void {
		const taskId = active.node.id;
		active.paused = true;
		this.dag.markPaused(taskId);
		if (kind === "completion") this.completionGates.add(taskId);
		this.persist("approval_request", { runId: this.runId, taskId, question, options, kind, ts: Date.now() });
		this.persistDisplay(`[${taskId}] ${question}\nOptions: ${options.join(", ")}`);
		this.snapshotDag();
		this.publish({
			type: "task_paused",
			taskId,
			role: active.node.role,
			agentId: active.agentId,
			question,
			options,
			ts: Date.now(),
		});
		// A paused node consumes no agent time; hand its slot to other work.
		this.slotsInUse--;
		this.waitForApproval({ taskId, question, options });
		this.fill();
	}

	/** Re-emit a restored gate without re-persisting its approval_request. */
	private surfacePause(request: ApprovalRequest): void {
		const node = this.dag.get(request.taskId);
		this.publish({
			type: "task_paused",
			taskId: request.taskId,
			role: node?.role ?? "",
			agentId: this.runId,
			question: request.question,
			options: request.options,
			ts: Date.now(),
		});
		this.waitForApproval(request);
	}

	private waitForApproval(request: ApprovalRequest): void {
		this.approvals.ask(request).then(
			(chosenOption) => {
				const node = this.dag.get(request.taskId);
				this.persist("approval_response", { runId: this.runId, taskId: request.taskId, chosenOption, ts: Date.now() });
				this.publish({
					type: "task_resumed",
					taskId: request.taskId,
					role: node?.role ?? "",
					agentId: this.active.get(request.taskId)?.agentId ?? this.runId,
					chosenOption,
					ts: Date.now(),
				});
				if (this.completionGates.delete(request.taskId)) {
					this.resolveCompletionGate(request.taskId, chosenOption);
					return;
				}
				this.resumeQueue.push({ taskId: request.taskId, text: chosenOption });
				this.fill();
			},
			(err) => {
				// Approval timed out with no default: the gate fails the node.
				// The node holds no slot while paused.
				this.completionGates.delete(request.taskId);
				this.settleNode(request.taskId, true, { error: err, holdsSlot: false });
			},
		);
	}

	/** Called by fill() with a slot already claimed for the task. */
	private resumeNode(taskId: string, text: string): void {
		const node = this.dag.get(taskId);
		if (!node) return;
		this.dag.markRunning(taskId);
		this.snapshotDag();
		const active = this.active.get(taskId);
		if (!active) {
			// Restored gate: no live harness. The factory reopens the node's
			// session, so prompting with the answer lands in its context.
			void this.dispatchNode(node, text);
			return;
		}
		active.paused = false;
		if (active.runActive) {
			// Marker arrived mid-run and the run is still going: inject the
			// answer as a steering message. The harness may have gone idle in
			// the meantime (steer() throws while idle) — fall back to a fresh
			// prompt.
			try {
				active.harness.steer(text);
			} catch {
				this.startRun(active, text);
			}
			return;
		}
		this.startRun(active, text);
	}

	/**
	 * Resolve a completion gate. "approve" settles the node done; anything else
	 * ("revise", optionally with feedback on later lines) re-prompts the live
	 * agent, which re-opens the gate when it settles again.
	 */
	private resolveCompletionGate(taskId: string, chosenOption: string): void {
		const [head, ...rest] = chosenOption.split("\n");
		const decision = (head ?? "").trim().toLowerCase();
		if (decision.startsWith("approve")) {
			const active = this.active.get(taskId);
			// The gate already released the node's slot; settle without double-freeing.
			this.settleNode(taskId, false, { messages: active?.lastMessages, holdsSlot: false });
			return;
		}
		// "revise": re-prompt with the feedback. fill() reclaims the freed slot.
		const feedback = rest.join("\n").trim();
		const text = feedback.length > 0 ? feedback : "Please revise your previous work and try again.";
		this.resumeQueue.push({ taskId, text });
		this.fill();
	}

	private onRunSettled(active: ActiveNode, err?: unknown): void {
		if (active.paused) {
			// The run ended on the approval marker; resumeNode starts the next
			// run when the answer arrives. (If the run errored while paused,
			// the resume prompt still runs on the same harness.)
			return;
		}
		if (err !== undefined) {
			this.settleNode(active.node.id, true, { error: err });
			return;
		}
		const last = active.lastMessages?.[active.lastMessages.length - 1];
		const failed = last?.role === "assistant" && Boolean((last as { errorMessage?: string }).errorMessage);
		// HITL: a clean run end opens a completion gate instead of settling done.
		// The human approves (settle) or revises (re-prompt). Failed runs settle as
		// error directly — there is nothing to approve.
		if (!failed && !this.allowAutonomous) {
			this.pauseForCompletion(active);
			return;
		}
		this.settleNode(active.node.id, failed, { messages: active.lastMessages });
	}

	private settleNode(taskId: string, failed: boolean, opts: { messages?: AgentMessage[]; error?: unknown; holdsSlot?: boolean }): void {
		const active = this.active.get(taskId);
		if (active) {
			active.unsubscribe();
			this.active.delete(taskId);
		}
		const node = this.dag.get(taskId);
		if (failed) {
			this.dag.markFailed(taskId);
		} else {
			this.dag.markDone(taskId, opts.messages);
		}
		this.persist("task_end", {
			runId: this.runId,
			taskId,
			status: failed ? "error" : "done",
			error: opts.error === undefined ? undefined : opts.error instanceof Error ? opts.error.message : String(opts.error),
			ts: Date.now(),
		});
		this.publish({
			type: "task_finished",
			taskId,
			role: node?.role ?? "",
			agentId: active?.agentId ?? this.runId,
			status: failed ? "error" : "done",
			ts: Date.now(),
		});
		if (opts.error !== undefined) {
			this.publish({
				type: "team_error",
				error: opts.error instanceof Error ? opts.error.message : String(opts.error),
				role: node?.role ?? "",
				agentId: active?.agentId ?? this.runId,
				ts: Date.now(),
			});
		}
		this.snapshotDag();
		if (opts.holdsSlot !== false) {
			this.slotsInUse--;
		}
		this.fill();
		this.checkSettled();
	}

	private checkSettled(): void {
		if (this.finished || !this.settle || !this.dag.isComplete()) return;
		this.finished = true;
		const failed = this.dag.all().some((node) => node.status === "error");
		this.persist("run_end", { runId: this.runId, status: failed ? "failed" : "complete", ts: Date.now() });
		this.snapshotDag();
		this.publish({
			type: failed ? "dag_failed" : "dag_complete",
			runId: this.runId,
			role: "orchestrator",
			agentId: this.runId,
			ts: Date.now(),
		});
		void this.flush().then(this.settle);
	}

	private snapshotDag(): void {
		this.persist("dag_state", { runId: this.runId, dag: this.dag.toJSON(), ts: Date.now() });
	}

	/**
	 * Queue a session write. Writes are serialized on one promise chain so
	 * concurrent node activity can't interleave appends (the session tree has
	 * a single leaf pointer), while call sites stay non-blocking. flush()
	 * awaits the chain; run() flushes before resolving.
	 */
	private persist(customType: string, data: Record<string, unknown>): void {
		this.enqueueWrite(() => this.session.appendCustomEntry(customType, data));
	}

	private persistDisplay(content: string): void {
		this.enqueueWrite(() => this.session.appendCustomMessageEntry("approval_request", content, true));
	}

	private enqueueWrite(write: () => Promise<unknown>): void {
		this.writeChain = this.writeChain.then(write).then(
			() => {},
			(err) => this.reportWriteFailure(err),
		);
	}

	private reportWriteFailure(err: unknown): void {
		this.publish({
			type: "team_error",
			error: `session write failed: ${err instanceof Error ? err.message : String(err)}`,
			role: "orchestrator",
			agentId: this.runId,
			ts: Date.now(),
		});
	}

	private publish(event: TeamEvent): void {
		this.channel?.publish(event);
	}
}
