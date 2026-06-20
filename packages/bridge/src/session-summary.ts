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

/**
 * How long a run with no `run_end` may sit idle before it's treated as
 * interrupted (process killed/crashed mid-run) rather than still running.
 * Five minutes comfortably exceeds any normal gap between session writes — a
 * live run snapshots the dag on every settle/pause, and even a long single
 * agent turn writes well inside this window.
 */
export const DEFAULT_STALE_RUN_MS = 5 * 60 * 1000;

/** One run as the sidebar lists it — derived purely from the on-disk log. */
export interface SessionSummary {
	runId: string;
	goal?: string;
	/**
	 * running until a run_end lands; then done/error. A run that never wrote a
	 * run_end and has been idle past DEFAULT_STALE_RUN_MS is reconciled to
	 * "interrupted" so orphaned runs (killed/crashed mid-run) don't pile up
	 * forever as "running" (L2).
	 */
	status: "running" | "done" | "error" | "interrupted";
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
export function summarizeSession(jsonl: string, now: number = Date.now(), staleMs: number = DEFAULT_STALE_RUN_MS): SessionSummary | null {
	let runId = "";
	let goal: string | undefined;
	let status: SessionSummary["status"] = "running";
	let startedAt: number | undefined;
	let total = 0;
	let ended = false;
	// Newest timestamp seen on any entry, used to tell an idle (still streaming)
	// run from an orphaned one when no run_end was ever written.
	let lastTs: number | undefined;
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
		if (typeof data.ts === "number" && (lastTs === undefined || data.ts > lastTs)) lastTs = data.ts;

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
				ended = true;
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
	// Reconcile an orphaned run: no run_end and no activity for staleMs means the
	// process died mid-run, so report it as interrupted instead of a zombie
	// "running" that never resolves (L2). A run still inside the window stays
	// "running" — it may just be between writes.
	if (!ended && lastTs !== undefined && now - lastTs > staleMs) {
		status = "interrupted";
	}
	return {
		runId,
		goal,
		status,
		done: doneFromDag ?? 0,
		total: total || dagSize,
		startedAt,
	};
}
