import type { DagNode, DagState, RunInfo, SessionEntry } from "./types";

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
 * List available sessions from the server.
 */
export async function listSessions(host: string): Promise<Array<{ runId: string; filename: string }>> {
	try {
		const resp = await fetch(`${host}/sessions`);
		if (resp.ok) {
			return await resp.json();
		}
	} catch {
		// Continue
	}
	return [];
}
