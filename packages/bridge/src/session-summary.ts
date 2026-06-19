/**
 * Cheap, server-side digest of a session JSONL log.
 *
 * The sidebar's run list only needs a one-line summary per run — goal, status,
 * task counts, start time — not the full reconstructed DAG/transcript. Parsing
 * that summary here (where the file is already on disk) lets GET /sessions
 * return everything the list needs in a single call, instead of the web UI
 * fetching and fully parsing every session file (an N+1 request storm).
 *
 * This intentionally mirrors a subset of the web UI's parseSession
 * (packages/webui/src/lib/session.ts): same JSONL shape, same customType names,
 * but it stops at counts rather than building per-node detail. Keep the two in
 * sync when the persisted session shape changes.
 */

/** One run as the sidebar lists it — derived purely from the on-disk log. */
export interface SessionSummary {
	runId: string;
	goal?: string;
	/** running until a run_end lands; then done/error. */
	status: "running" | "done" | "error";
	/** Tasks in a terminal "done" state, from the latest dag_state snapshot. */
	done: number;
	/** Total tasks declared for the run (run_config), falling back to dag size. */
	total: number;
	/** run_start timestamp (ms), for newest-first ordering. */
	startedAt?: number;
}

/**
 * Fold a session JSONL string into a SessionSummary, or null when the log has
 * no identifiable run (no runId in any entry). Malformed lines are skipped so a
 * partially-written log (e.g. a crashed run) still summarizes.
 */
export function summarizeSession(jsonl: string): SessionSummary | null {
	let runId = "";
	let goal: string | undefined;
	let status: SessionSummary["status"] = "running";
	let startedAt: number | undefined;
	let total = 0;
	// Latest dag_state wins for the done count — it's the authoritative snapshot.
	let doneFromDag: number | undefined;
	let dagSize = 0;

	for (const line of jsonl.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: { type?: string; customType?: string; data?: Record<string, unknown> };
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry.type !== "custom" || !entry.customType || !entry.data) continue;
		const data = entry.data as Record<string, any>;

		switch (entry.customType) {
			case "run_config": {
				runId = (data.runId as string) ?? runId;
				goal = data.goal as string | undefined;
				if (Array.isArray(data.tasks)) total = data.tasks.length;
				break;
			}
			case "run_start": {
				runId = (data.runId as string) ?? runId;
				startedAt = data.ts as number | undefined;
				break;
			}
			case "run_end": {
				status = data.status === "error" || data.status === "failed" ? "error" : "done";
				break;
			}
			case "dag_state": {
				runId = (data.runId as string) ?? runId;
				if (data.dag && typeof data.dag === "object") {
					const nodes = Object.values(data.dag as Record<string, { status?: string }>);
					dagSize = nodes.length;
					doneFromDag = nodes.filter(
						(n) => n.status === "done" || n.status === "completed",
					).length;
				}
				break;
			}
		}
	}

	if (!runId) return null;
	return {
		runId,
		goal,
		status,
		done: doneFromDag ?? 0,
		total: total || dagSize,
		startedAt,
	};
}
