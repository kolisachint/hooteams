import type { Session } from "@kolisachint/hoocode-agent-core";
import { randomUUID } from "node:crypto";
import { ApprovalRegistry, type ApprovalRequest } from "./ask-options.js";
import type { TeamChannel } from "./channel.js";
import { TaskDag } from "@kolisachint/hooteams-dag";
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
	/**
	 * Released when the node is torn down (settled or about to retry), e.g. to
	 * drop a messaging registration the factory set up. Called at most once per
	 * handle; a throw is swallowed so cleanup can never block settlement.
	 */
	dispose?: () => void;
}

/**
 * Goal-completion validation run once every node settles "done": the
 * validator sees the goal and each task's output, and its verdict either
 * settles the run or sends one task back for rework (see GOAL_UNMET_MARKER).
 */
export interface RunValidator {
	/** One validation pass over the goal + task outputs; resolves with the validator's reply text. */
	validate: (context: string) => Promise<string>;
	/** The goal the run is judged against, included in the validation context. */
	goal?: string;
	/** Max validation passes before an unmet verdict fails the run. Default 2. */
	maxRounds?: number;
}

/**
 * Cross-run shared memory hook, decoupled from any concrete store. TeamMemory
 * satisfies recordTask directly; hosts compute bootstrapContext once before
 * the run (e.g. await TeamMemory.bootstrapContext()).
 */
export interface RunMemory {
	/**
	 * Context from prior runs on the project, appended to the prompts of root
	 * tasks (tasks with no dependencies) so a new run starts with what the
	 * team already learned.
	 */
	bootstrapContext?: string;
	/**
	 * Persist one settled task's output, called for every done/error task at
	 * run end. Failures are surfaced as team_error events, never thrown.
	 */
	recordTask: (task: { runId: string; taskId: string; role: string; status: "done" | "error"; output?: string }) => Promise<void> | void;
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
	/**
	 * Text that starts a node's run. Defaults to the node id (parity with
	 * Orchestrator). The outputs of the node's completed dependencies are
	 * appended to this, so results chain through the dag.
	 */
	taskPrompt?: (node: TaskNode) => string;
	/**
	 * When false, the orchestrator opens a deterministic completion gate before
	 * each node settles "done" (human-in-the-loop). Defaults to true (autonomous)
	 * so the library stays backward-compatible; the server/CLI default it to
	 * false so `hooteams start` is HITL by default. See docs/hitl-gates.md.
	 */
	allowAutonomous?: boolean;
	/**
	 * Called when a node fails permanently (its retries are exhausted). Hosts
	 * use this to escalate structurally, e.g. steering the failure summary to
	 * a planner agent that can spawn a recovery specialist or re-delegate.
	 */
	onTaskFailed?: (node: TaskNode, error: string) => void;
	/** Goal-completion validation run after the dag completes cleanly. */
	validator?: RunValidator;
	/**
	 * Cross-run shared memory: bootstrapContext is appended to root task
	 * prompts, and every settled task is recorded via recordTask at run end.
	 */
	memory?: RunMemory;
	/**
	 * Last chance to shape a node's prompt before dispatch. Receives the node and
	 * the composed base prompt (task prompt + dependency outputs + memory
	 * bootstrap) and returns the text the agent is actually prompted with. Runs
	 * only on a node's own dispatch, not on an approval resume. A throw fails the
	 * node like any other dispatch error.
	 */
	prepareTaskPrompt?: (node: TaskNode, basePrompt: string) => string | Promise<string>;
	/**
	 * Observe every node as it settles done or error (after retries are
	 * exhausted), e.g. to stream progress or update an external tracker. Receives
	 * the settled node, output included. Best-effort: a throw or rejection is
	 * swallowed so it can never block the run.
	 */
	afterTaskSettle?: (node: TaskNode, status: "done" | "error") => void | Promise<void>;
}

/**
 * Mid-run approval gate: an agent that needs a human decision ends its
 * message with a line in this shape and stops. The orchestrator pauses the
 * node, surfaces a "task_paused" TeamEvent, and resumes the agent with the
 * chosen option once resume() is called.
 */
export const APPROVAL_MARKER = /^AWAITING_APPROVAL:\s*(.+?)\s*\|\s*(.+)$/m;

/**
 * Verdict line a goal validator ends with when the goal was not achieved:
 * a reason and the id of the task whose work must be redone. Any reply
 * without this line counts as GOAL_MET.
 */
export const GOAL_UNMET_MARKER = /^GOAL_UNMET:\s*(.+?)\s*\|\s*(\S+)\s*$/m;

/** Concatenated text parts of a message ("" when it has none). */
export function extractMessageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

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
	/** Factory cleanup (e.g. drop the node's messaging registration); called once on teardown. */
	dispose?: () => void;
	/** Messages of the most recent agent_end, used as the node's results. */
	lastMessages?: AgentMessage[];
	paused: boolean;
	/** True between a prompt() call and its settlement. */
	runActive: boolean;
	/** True once an advisor node's task has settled: its later runs (answering
	 * peers) only mirror events and never re-trigger gate/marker/settle logic. */
	settledAdvisor?: boolean;
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
	private readonly onTaskFailed?: (node: TaskNode, error: string) => void;
	private readonly validator?: RunValidator;
	private readonly memory?: RunMemory;
	private readonly prepareTaskPrompt?: (node: TaskNode, basePrompt: string) => string | Promise<string>;
	private readonly afterTaskSettle?: (node: TaskNode, status: "done" | "error") => void | Promise<void>;
	private validationRounds = 0;
	/** True while a validation pass is in flight; blocks settlement. */
	private validating = false;
	private readonly active = new Map<string, ActiveNode>();
	/** Advisor nodes whose task has settled but whose agent stays live as a
	 * messaging target until the run ends (see TaskNode.advisor). */
	private readonly advisors = new Map<string, ActiveNode>();
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
		this.onTaskFailed = options.onTaskFailed;
		this.validator = options.validator;
		this.memory = options.memory;
		this.prepareTaskPrompt = options.prepareTaskPrompt;
		this.afterTaskSettle = options.afterTaskSettle;
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
			try {
				for (const request of this.restoredApprovals) {
					this.surfacePause(request);
				}
				this.restoredApprovals = [];
				this.fill();
				this.checkSettled();
			} catch (err) {
				this.handleRunFailure(err);
			}
		});
	}

	/**
	 * A run-level failure outside any node's own settlement (e.g. the dispatch
	 * loop threw): emit a team_error and drive the same full failure lifecycle
	 * finish() does (run_end "failed", final dag snapshot, dag_failed), so the
	 * run promise always resolves with a complete event sequence instead of
	 * rejecting or hanging.
	 */
	private handleRunFailure(error: unknown): void {
		if (this.finished) return;
		this.publish({
			type: "team_error",
			error: `run failed: ${error instanceof Error ? error.message : String(error)}`,
			role: "orchestrator",
			agentId: this.runId,
			ts: Date.now(),
		});
		this.finish(true);
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
			// Mark before the async compose/dispatch so a re-entrant fill() can't
			// pick the same ready node twice.
			this.dag.markRunning(node.id);
			void this.dispatchReady(node);
		}
	}

	/**
	 * Compose a ready node's prompt, run it through the optional prepareTaskPrompt
	 * hook, and dispatch it. A compose/hook failure settles the node as errored
	 * (it already holds a slot, claimed by fill()).
	 */
	private async dispatchReady(node: TaskNode): Promise<void> {
		let text: string;
		try {
			const base = this.composePrompt(node);
			text = this.prepareTaskPrompt ? await this.prepareTaskPrompt(node, base) : base;
		} catch (err) {
			this.settleNode(node.id, true, { error: err });
			return;
		}
		await this.dispatchNode(node, text);
	}

	/**
	 * The node's task prompt plus the outputs of its completed dependencies.
	 * Root tasks (no deps) additionally get the prior-run memory bootstrap, so
	 * a new run starts where earlier runs on the project left off.
	 */
	private composePrompt(node: TaskNode): string {
		const parts = [this.taskPrompt(node)];
		const sections = node.deps
			.map((dep) => this.dag.get(dep))
			.filter((dep): dep is TaskNode => Boolean(dep?.output))
			.map((dep) => `### ${dep.id} (${dep.role})\n${dep.output}`);
		if (sections.length > 0) {
			parts.push(`Results from the tasks this one depends on:\n\n${sections.join("\n\n")}`);
		}
		if (node.deps.length === 0 && this.memory?.bootstrapContext) {
			parts.push(this.memory.bootstrapContext);
		}
		return parts.join("\n\n");
	}

	private async dispatchNode(node: TaskNode, text: string): Promise<void> {
		// Callers (dispatchReady and resumeNode) mark the node running before this
		// runs, so a re-entrant fill() can't dispatch it again across the awaits.
		// If this node is a live advisor being re-dispatched (e.g. the validator
		// bounced it), tear the prior live instance down first so it can't orphan
		// its subscription/registration.
		this.disposeAdvisor(node.id);
		try {
			const handle = await this.createHarness(node);
			const active: ActiveNode = {
				node,
				harness: handle.harness,
				agentId: handle.agentId ?? randomUUID(),
				sessionId: handle.sessionId,
				unsubscribe: () => {},
				dispose: handle.dispose,
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
		// A settled advisor answering a peer: keep mirroring its events (so
		// ask_agent sees the agent_end) but never re-open a gate or re-settle a
		// node that is already done.
		if (active.settledAdvisor) return;
		if (event.type === "agent_end") {
			active.lastMessages = event.messages;
			return;
		}
		if (event.type === "message_end" && !active.paused && event.message.role === "assistant") {
			const match = APPROVAL_MARKER.exec(extractMessageText(event.message));
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
		if (!failed && this.shouldGate(active.node)) {
			this.pauseForCompletion(active);
			return;
		}
		this.settleNode(active.node.id, failed, { messages: active.lastMessages });
	}

	/**
	 * Whether a clean run end opens a completion gate: the node's own `gate`
	 * policy wins, falling back to the run-wide default (HITL gates every node
	 * unless allowAutonomous). This is what lets a run gate only at chosen nodes
	 * — e.g. autonomous everywhere, with gate:true on the merge node alone.
	 */
	private shouldGate(node: TaskNode): boolean {
		return node.gate ?? !this.allowAutonomous;
	}

	private settleNode(taskId: string, failed: boolean, opts: { messages?: AgentMessage[]; error?: unknown; holdsSlot?: boolean }): void {
		const node = this.dag.get(taskId);
		// An advisor settling "done" keeps its agent live and adopted (a messaging
		// target) until the run ends, instead of being torn down now. A failed
		// advisor tears down normally — a broken advisor is no advisor.
		const keepAlive = !failed && Boolean(node?.advisor);
		const active = this.active.get(taskId);
		if (active) {
			this.active.delete(taskId);
			if (keepAlive) {
				active.settledAdvisor = true;
				this.advisors.set(taskId, active); // stays subscribed + adopted for peers
			} else {
				active.unsubscribe();
				// Drop the node's messaging registration (or any other factory cleanup)
				// the moment it's torn down — on retry a fresh harness re-registers.
				try {
					active.dispose?.();
				} catch {
					// Cleanup is best-effort; a throwing dispose must not block settlement.
				}
			}
		}
		const errorText =
			opts.error === undefined
				? failed
					? this.lastAssistantError(opts.messages) ?? "task failed"
					: undefined
				: opts.error instanceof Error
					? opts.error.message
					: String(opts.error);
		if (failed && node && (node.attempts ?? 0) < (node.retries ?? 0)) {
			this.retryNode(node, active, errorText ?? "task failed", opts.holdsSlot !== false);
			return;
		}
		if (failed) {
			this.dag.markFailed(taskId);
		} else {
			this.dag.markDone(taskId, opts.messages);
			this.dag.setOutput(taskId, this.lastAssistantText(opts.messages));
		}
		this.persist("task_end", {
			runId: this.runId,
			taskId,
			status: failed ? "error" : "done",
			error: errorText,
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
		if (failed && node && this.onTaskFailed) {
			try {
				this.onTaskFailed(node, errorText ?? "task failed");
			} catch {
				// Escalation is best-effort; a throwing hook must not block settlement.
			}
		}
		if (this.afterTaskSettle) {
			const settled = this.dag.get(taskId);
			if (settled) {
				try {
					const result = this.afterTaskSettle(settled, failed ? "error" : "done");
					if (result instanceof Promise) result.catch(() => {});
				} catch {
					// Best-effort observer; a throwing hook must not block settlement.
				}
			}
		}
		this.snapshotDag();
		if (opts.holdsSlot !== false) {
			this.slotsInUse--;
		}
		this.fill();
		this.checkSettled();
	}

	/** Reset a failed node to idle for another attempt; called by settleNode with the active entry already removed. */
	private retryNode(node: TaskNode, active: ActiveNode | undefined, error: string, holdsSlot: boolean): void {
		const attempt = this.dag.incrementAttempts(node.id);
		this.dag.resetToIdle(node.id);
		this.persist("task_retry", { runId: this.runId, taskId: node.id, attempt, error, ts: Date.now() });
		this.publish({
			type: "task_retried",
			taskId: node.id,
			role: node.role,
			agentId: active?.agentId ?? this.runId,
			attempt,
			error,
			ts: Date.now(),
		});
		this.snapshotDag();
		if (holdsSlot) {
			this.slotsInUse--;
		}
		this.fill();
	}

	/** Text of the last assistant message, or undefined when there is none. */
	private lastAssistantText(messages?: AgentMessage[]): string | undefined {
		for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
			const message = messages![i]!;
			if (message.role === "assistant") {
				const text = extractMessageText(message);
				return text.length > 0 ? text : undefined;
			}
		}
		return undefined;
	}

	private lastAssistantError(messages?: AgentMessage[]): string | undefined {
		const last = messages?.[messages.length - 1];
		const errorMessage = last?.role === "assistant" ? (last as { errorMessage?: string }).errorMessage : undefined;
		return errorMessage || this.lastAssistantText(messages);
	}

	private checkSettled(): void {
		if (this.finished || !this.settle || this.validating || !this.dag.isComplete()) return;
		const failed = this.dag.all().some((node) => node.status === "error");
		if (!failed && this.validator && this.validationRounds < (this.validator.maxRounds ?? 2)) {
			this.runValidation();
			return;
		}
		this.finish(failed);
	}

	/** Tear down one live advisor (subscription + messaging registration), if present. */
	private disposeAdvisor(taskId: string): void {
		const advisor = this.advisors.get(taskId);
		if (!advisor) return;
		this.advisors.delete(taskId);
		advisor.unsubscribe();
		try {
			advisor.dispose?.();
		} catch {
			// Best-effort cleanup; a throwing dispose must not block teardown.
		}
	}

	private finish(failed: boolean): void {
		this.finished = true;
		// Advisors stay live only for the duration of the run; release them all now.
		for (const taskId of [...this.advisors.keys()]) this.disposeAdvisor(taskId);
		// Memory records before run_end persists and the dag event publishes, so
		// anything that observes the run as settled can already bootstrap a
		// follow-up run from this run's outputs.
		void this.recordToMemory()
			.then(() => {
				this.persist("run_end", { runId: this.runId, status: failed ? "failed" : "complete", ts: Date.now() });
				this.snapshotDag();
				this.publish({
					type: failed ? "dag_failed" : "dag_complete",
					runId: this.runId,
					role: "orchestrator",
					agentId: this.runId,
					ts: Date.now(),
				});
				return this.flush();
			})
			.then(this.settle);
	}

	/** Record every settled task in shared memory. Best-effort: a failing store must not fail the run. */
	private async recordToMemory(): Promise<void> {
		if (!this.memory) return;
		for (const node of this.dag.all()) {
			if (node.status !== "done" && node.status !== "error") continue;
			try {
				await this.memory.recordTask({
					runId: this.runId,
					taskId: node.id,
					role: node.role,
					status: node.status,
					output: node.output,
				});
			} catch (err) {
				this.publish({
					type: "team_error",
					error: `memory write failed for task "${node.id}": ${err instanceof Error ? err.message : String(err)}`,
					role: "orchestrator",
					agentId: this.runId,
					ts: Date.now(),
				});
			}
		}
	}

	private runValidation(): void {
		this.validating = true;
		const round = ++this.validationRounds;
		this.persist("validation_start", { runId: this.runId, round, ts: Date.now() });
		this.validator!.validate(this.validationContext()).then(
			(verdict) => this.onVerdict(round, verdict),
			(err) => {
				// A broken validator must not hold the run open or fail clean work.
				this.validating = false;
				const error = err instanceof Error ? err.message : String(err);
				this.persist("validation_result", { runId: this.runId, round, met: true, error, ts: Date.now() });
				this.publish({ type: "team_error", error: `goal validation errored: ${error}`, role: "orchestrator", agentId: this.runId, ts: Date.now() });
				this.finish(false);
			},
		);
	}

	private onVerdict(round: number, verdict: string): void {
		this.validating = false;
		const unmet = GOAL_UNMET_MARKER.exec(verdict);
		const reason = unmet?.[1]?.trim();
		const retryTaskId = unmet?.[2]?.trim();
		this.persist("validation_result", { runId: this.runId, round, met: !unmet, reason, retryTaskId, ts: Date.now() });
		if (!unmet) {
			this.finish(false);
			return;
		}
		const node = retryTaskId ? this.dag.get(retryTaskId) : undefined;
		const roundsLeft = this.validationRounds < (this.validator?.maxRounds ?? 2);
		if (!node || !roundsLeft) {
			this.publish({
				type: "team_error",
				error: `goal validation: ${reason}${node ? "" : ` (unknown task "${retryTaskId}")`}`,
				role: "orchestrator",
				agentId: this.runId,
				ts: Date.now(),
			});
			this.finish(true);
			return;
		}
		// Send the named task back for rework; the dag is open again, so the
		// run continues and the next completion triggers another validation pass.
		this.reworkWithDependents(node, `goal validation: ${reason}`);
	}

	/**
	 * Send a node back for rework and reset its already-done dependents to idle,
	 * so they re-run against the corrected output instead of keeping results
	 * computed from the node's previous (rejected) work. The dag holds the
	 * dependents blocked until the reworked node completes again, so ordering is
	 * preserved. Dependents don't consume their own retry budget — the rerun is
	 * not their failure.
	 */
	private reworkWithDependents(node: TaskNode, error: string): void {
		for (const dependentId of this.dag.dependentsOf(node.id)) {
			if (this.dag.get(dependentId)?.status !== "done") continue;
			const dependent = this.dag.resetToIdle(dependentId);
			const reason = `re-run: upstream "${node.id}" was reworked`;
			this.persist("task_retry", { runId: this.runId, taskId: dependentId, attempt: dependent.attempts ?? 0, error: reason, ts: Date.now() });
			this.publish({
				type: "task_retried",
				taskId: dependentId,
				role: dependent.role,
				agentId: this.runId,
				attempt: dependent.attempts ?? 0,
				error: reason,
				ts: Date.now(),
			});
		}
		this.retryNode(node, undefined, error, false);
	}

	/** Goal + every task's output, as the validator's prompt. */
	private validationContext(): string {
		const goal = this.validator?.goal;
		const sections = this.dag
			.all()
			.map((node) => `### ${node.id} (${node.role}) — ${node.status}\n${node.output ?? "(no output recorded)"}`);
		return [
			goal ? `The team's goal:\n${goal}` : "No explicit goal was recorded for this run; judge against the tasks themselves.",
			"Every task has completed. Task outputs:",
			sections.join("\n\n"),
			'Did the team actually achieve the goal? End your reply with exactly one line:\nGOAL_MET\nor\nGOAL_UNMET: <reason> | <id of the task to re-run>',
		].join("\n\n");
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
