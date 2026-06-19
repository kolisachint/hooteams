import type {
	DagNode,
	DagState,
	PendingApproval,
	RunInfo,
	SessionEntry,
	TeamConfig,
	ToolChipState,
	TranscriptEntry,
} from "./types";

/**
 * Parse a JSONL session file content into a RunInfo.
 * The session file contains entries with type: "custom" and various customType values.
 */
export function parseSession(jsonl: string): RunInfo | null {
	const lines = jsonl.trim().split("\n").filter(Boolean);
	let runId = "";
	let goal: string | undefined;
	const dag: DagState = {};
	let status: RunInfo["status"] = "running";
	let startedAt: number | undefined;
	let endedAt: number | undefined;
	let teamConfig: TeamConfig | undefined;
	// Gates opened (approval_request) minus those answered (approval_response).
	// What's left is still awaiting a decision at the end of the session — a
	// marker-driven pause can land on any node, not just statically-gated ones.
	const pending: Record<string, PendingApproval> = {};

	for (const line of lines) {
		let entry: SessionEntry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type !== "custom" || !entry.customType || !entry.data) continue;

		const data = entry.data as Record<string, any>;

		switch (entry.customType) {
			case "run_config": {
				runId = data.runId ?? runId;
				goal = data.goal;
				// Initialize DAG from tasks
				if (Array.isArray(data.tasks)) {
					for (const task of data.tasks) {
						if (task.id && task.role) {
							dag[task.id] = {
								id: task.id,
								role: task.role,
								deps: task.deps ?? [],
								status: "idle",
								retries: task.retries,
								advisor: task.advisor,
								gate: task.gate,
							};
						}
					}
				}
				break;
			}

			case "run_start": {
				runId = data.runId ?? runId;
				startedAt = data.ts;
				break;
			}

			case "team_config": {
				runId = data.runId ?? runId;
				teamConfig = {
					defaults: data.defaults,
					maxConcurrent: data.maxConcurrent,
					validator: data.validator,
					roles: Array.isArray(data.roles) ? data.roles : [],
				};
				break;
			}

			case "run_end": {
				endedAt = data.ts;
				status = data.status === "done" ? "done" : data.status === "error" ? "error" : "done";
				break;
			}

			case "dag_state": {
				runId = data.runId ?? runId;
				// Update DAG state from dag_state entries
				if (data.dag && typeof data.dag === "object") {
					for (const [taskId, nodeData] of Object.entries(data.dag)) {
						const nd = nodeData as Record<string, any>;
						const existing = dag[taskId];
						dag[taskId] = {
							id: taskId,
							role: nd.role ?? existing?.role ?? taskId,
							deps: nd.deps ?? existing?.deps ?? [],
							status: mapStatus(nd.status),
							retries: nd.retries ?? existing?.retries,
							advisor: nd.advisor ?? existing?.advisor,
							gate: nd.gate ?? existing?.gate,
							results: nd.results ?? existing?.results,
						};
					}
				}
				break;
			}

			case "task_start": {
				runId = data.runId ?? runId;
				const taskId = data.taskId;
				if (taskId && dag[taskId]) {
					dag[taskId].status = "running";
				}
				break;
			}

			case "task_end": {
				const taskId = data.taskId;
				if (taskId && dag[taskId]) {
					dag[taskId].status =
						data.status === "done" ? "done" : data.status === "error" ? "error" : mapStatus(data.status);
				}
				break;
			}

			case "task_retried": {
				const taskId = data.taskId;
				if (taskId && dag[taskId]) {
					dag[taskId].status = "retrying";
					dag[taskId].retries = (dag[taskId].retries ?? 0) + 1;
				}
				break;
			}

			case "approval_request": {
				const taskId = data.taskId;
				if (taskId) {
					pending[taskId] = { taskId, question: data.question, options: data.options };
				}
				break;
			}

			case "approval_response": {
				const taskId = data.taskId;
				if (taskId) delete pending[taskId];
				break;
			}
		}
	}

	if (!runId) return null;

	return {
		runId,
		goal,
		dag,
		status,
		startedAt,
		endedAt,
		pending: Object.keys(pending).length > 0 ? pending : undefined,
		teamConfig,
	};
}

/** Map hooteams task status to our TaskStatus type. */
function mapStatus(status: string): DagNode["status"] {
	switch (status) {
		case "running":
			return "running";
		case "done":
		case "completed":
			return "done";
		case "error":
		case "failed":
			return "error";
		case "pending":
		case "paused":
			return "pending";
		case "retrying":
		case "retry":
			return "retrying";
		default:
			return "idle";
	}
}

/**
 * Fetch session file from hooteams server or local public directory.
 * Tries multiple paths:
 * 1. /sessions/:runId (hooteams server endpoint)
 * 2. /sessions/:runId.jsonl (Vite public directory)
 * 3. Direct file fetch from host
 */
export async function fetchSession(runId: string, host: string): Promise<RunInfo | null> {
	// Try the hooteams sessions endpoint first
	try {
		const resp = await fetch(`${host}/sessions/${runId}`);
		if (resp.ok) {
			const text = await resp.text();
			return parseSession(text);
		}
	} catch {
		// Endpoint might not exist, continue
	}

	// Try fetching from local public directory (Vite dev server)
	try {
		const resp = await fetch(`/sessions/${runId}.jsonl`);
		if (resp.ok) {
			const text = await resp.text();
			return parseSession(text);
		}
	} catch {
		// Continue
	}

	// Try fetching from the file system path (requires server support)
	try {
		const resp = await fetch(`${host}/session/${runId}.jsonl`);
		if (resp.ok) {
			const text = await resp.text();
			return parseSession(text);
		}
	} catch {
		// Continue
	}

	return null;
}

/**
 * A run's persisted log as `GET /sessions` reports it: `filename` is relative to
 * the sessions dir, `path` is absolute. Newer servers also fold in a cheap
 * server-side summary (goal/status/done/total/startedAt) so the web UI can
 * render its run list from this single call without fetching and parsing every
 * session file itself. The summary fields are optional for back-compat with
 * older servers that list ids only.
 */
export interface SessionListItem {
	runId: string;
	filename: string;
	/** Absolute on-disk path, surfaced by newer servers (undefined on older ones). */
	path?: string;
	goal?: string;
	status?: RunInfo["status"];
	done?: number;
	total?: number;
	startedAt?: number;
}

/**
 * List available sessions from the server.
 */
export async function listSessions(host: string): Promise<SessionListItem[]> {
	try {
		const resp = await fetch(`${host}/sessions`);
		if (resp.ok) {
			return (await resp.json()) as SessionListItem[];
		}
	} catch {
		// Continue
	}
	return [];
}

// ── Lazy transcript loading ───────────────────────────────────────────────────

/** In-memory cache: runId:taskId → transcript entries, so re-clicks are instant. */
const transcriptCache = new Map<string, TranscriptEntry[]>();

/**
 * Parse an agent session JSONL (type: "message" entries) into TranscriptEntry[].
 * Each message pair (user + assistant) becomes one turn entry with text, thinking,
 * tool calls, and usage stats.
 */
function parseAgentSession(jsonl: string): TranscriptEntry[] {
	const lines = jsonl.trim().split("\n").filter(Boolean);
	const entries: TranscriptEntry[] = [];
	let currentTurn: {
		text: string;
		thinking: string;
		tools: ToolChipState[];
		usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
		error?: string;
	} | null = null;

	for (const line of lines) {
		let entry: { type?: string; message?: Record<string, any> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		if (msg.role === "user") {
			// Steer/nudge messages from the user mid-run
			const text = msg.content?.map((c: any) => c.text ?? "").join("") ?? "";
			if (text) entries.push({ kind: "nudge", text });
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const tools: ToolChipState[] = [];

			for (const block of msg.content ?? []) {
				if (block.type === "text") {
					textParts.push(block.text ?? "");
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking ?? "");
				} else if (block.type === "toolCall") {
					tools.push({
						toolCallId: block.id ?? "",
						toolName: block.name ?? "unknown",
						status: "done",
						args: block.arguments,
					});
				}
			}

			// If this assistant message follows a previous one, flush the previous turn
			if (currentTurn) {
				entries.push({
					kind: "turn",
					text: currentTurn.text,
					thinking: currentTurn.thinking,
					tools: currentTurn.tools,
					usage: currentTurn.usage,
					error: currentTurn.error,
				});
			}

			currentTurn = {
				text: textParts.join(""),
				thinking: thinkingParts.join(""),
				tools,
				usage: msg.usage,
			};
		} else if (msg.role === "toolResult") {
			// Attach tool results to the current turn's tools
			if (currentTurn) {
				const tool = currentTurn.tools.find((t) => t.toolCallId === msg.toolCallId);
				if (tool) {
					tool.status = msg.isError ? "error" : "done";
					tool.result = { content: msg.content, details: msg.details, isError: msg.isError };
				}
			}
		}
	}

	// Flush the last turn
	if (currentTurn) {
		entries.push({
			kind: "turn",
			text: currentTurn.text,
			thinking: currentTurn.thinking,
			tools: currentTurn.tools,
			usage: currentTurn.usage,
			error: currentTurn.error,
		});
	}

	return entries;
}

/**
 * Fetch a single task's transcript from the server. Results are cached in memory
 * so re-clicks are instant. Returns null if the transcript can't be loaded.
 */
export async function fetchTranscript(runId: string, taskId: string, host: string): Promise<TranscriptEntry[] | null> {
	const cacheKey = `${runId}:${taskId}`;
	const cached = transcriptCache.get(cacheKey);
	if (cached) return cached;

	try {
		const resp = await fetch(
			`${host}/sessions/${encodeURIComponent(runId)}/transcript/${encodeURIComponent(taskId)}`,
		);
		if (!resp.ok) return null;
		const text = await resp.text();
		const entries = parseAgentSession(text);
		transcriptCache.set(cacheKey, entries);
		return entries;
	} catch {
		return null;
	}
}
