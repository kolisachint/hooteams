import type { Session } from "@kolisachint/hoocode-agent-core";

/** A question an agent needs a human to answer before its task can continue. */
export interface ApprovalRequest {
	taskId: string;
	question: string;
	options: string[];
	/** Auto-resolve after this many ms. Without defaultOption the wait rejects instead. */
	timeoutMs?: number;
	/** Option chosen when timeoutMs elapses unanswered (headless runs). */
	defaultOption?: string;
}

interface PendingApproval {
	request: ApprovalRequest;
	resolve: (option: string) => void;
	reject: (err: Error) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * In-flight approval gates, keyed by task id. Instance state on purpose: a
 * process can host several orchestrators (and tests run them concurrently),
 * so resolvers must not live in module scope. First answer wins; later
 * answers are reported as stale via resolve() returning false.
 */
export class ApprovalRegistry {
	private readonly pending = new Map<string, PendingApproval>();

	/** Register a gate and wait for its answer. One gate per task id at a time. */
	ask(request: ApprovalRequest): Promise<string> {
		if (this.pending.has(request.taskId)) {
			throw new Error(`Task "${request.taskId}" already has a pending approval`);
		}
		return new Promise<string>((resolve, reject) => {
			const entry: PendingApproval = { request, resolve, reject };
			if (request.timeoutMs !== undefined) {
				entry.timer = setTimeout(() => {
					this.pending.delete(request.taskId);
					if (request.defaultOption !== undefined) {
						resolve(request.defaultOption);
					} else {
						reject(new Error(`Approval for task "${request.taskId}" timed out after ${request.timeoutMs}ms`));
					}
				}, request.timeoutMs);
			}
			this.pending.set(request.taskId, entry);
		});
	}

	/**
	 * Answer a gate. Returns false when there is nothing pending for the task —
	 * either it was never paused or another surface answered first — so wire
	 * handlers can tell callers their answer was stale.
	 */
	resolve(taskId: string, option: string): boolean {
		const entry = this.pending.get(taskId);
		if (!entry) return false;
		this.pending.delete(taskId);
		if (entry.timer) clearTimeout(entry.timer);
		entry.resolve(option);
		return true;
	}

	has(taskId: string): boolean {
		return this.pending.has(taskId);
	}

	/** Snapshot of unanswered gates, e.g. to re-surface after a reconnect. */
	pendingRequests(): ApprovalRequest[] {
		return [...this.pending.values()].map((entry) => entry.request);
	}
}

/**
 * Spec-shaped convenience for standalone use: persist the gate to a session
 * (a machine-readable "approval_request" entry plus a display message any
 * attached hoocode TUI renders), wait for the answer, persist it, return it.
 *
 * TeamOrchestrator does not call this — it persists through its serialized
 * session writer and uses registry.ask() directly — but the entry shapes
 * written here are identical, so buildTrace()/restoreFromSession() understand
 * both.
 */
export async function askOptions(registry: ApprovalRegistry, request: ApprovalRequest, session?: Session): Promise<string> {
	if (session) {
		await session.appendCustomEntry("approval_request", {
			taskId: request.taskId,
			question: request.question,
			options: request.options,
			ts: Date.now(),
		});
		await session.appendCustomMessageEntry(
			"approval_request",
			`[${request.taskId}] ${request.question}\nOptions: ${request.options.join(", ")}`,
			true,
		);
	}
	const chosenOption = await registry.ask(request);
	if (session) {
		await session.appendCustomEntry("approval_response", { taskId: request.taskId, chosenOption, ts: Date.now() });
	}
	return chosenOption;
}
