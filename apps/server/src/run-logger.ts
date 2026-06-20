import type { TeamChannel, TeamEvent } from "@kolisachint/hooteams-orchestrator";

/**
 * Server-side run logging.
 *
 * `hooteams start` used to print only its startup banner, so an operator
 * watching the terminal had zero visibility into a run — no task starts, gates,
 * validation, errors, or settlement (L1). The web UI saw everything over SSE,
 * but the server itself was blind. This subscribes the server process to the
 * same TeamChannel and prints a concise line per run-level event, so the
 * terminal becomes a usable log without having to open the web UI.
 */

/** ISO-second timestamp prefix shared by every line, so logs are grep/sort-friendly. */
function stamp(ts: number): string {
	return new Date(ts).toISOString();
}

/**
 * Render one TeamEvent as a single server log line, or null for events that
 * are too noisy to log (per-token message/tool streaming, dag snapshots). Kept
 * pure so it can be unit-tested without capturing console output.
 */
export function formatRunLogLine(event: TeamEvent): string | null {
	switch (event.type) {
		case "task_started":
			return `${stamp(event.ts)} [run] ▶ task ${event.taskId} (${event.role}) started`;
		case "task_paused":
			return `${stamp(event.ts)} [run] ⏸ task ${event.taskId} paused — ${event.question} [${event.options.join(", ")}]`;
		case "task_resumed":
			return `${stamp(event.ts)} [run] ▶ task ${event.taskId} resumed with "${event.chosenOption}"`;
		case "task_retried":
			return `${stamp(event.ts)} [run] ↻ task ${event.taskId} retry ${event.attempt}: ${event.error}`;
		case "task_finished":
			return `${stamp(event.ts)} [run] ${event.status === "done" ? "✓" : "✗"} task ${event.taskId} ${event.status}`;
		case "team_error":
			return `${stamp(event.ts)} [run] ⚠ error (${event.role}): ${event.error}`;
		case "dag_complete":
			return `${stamp(event.ts)} [run] ✓ run ${event.runId} complete`;
		case "dag_failed":
			return `${stamp(event.ts)} [run] ✗ run ${event.runId} failed`;
		default:
			// message_update, tool_execution_*, dag_snapshot, agent_* — too chatty
			// for a server log; the web UI / SSE stream carries the fine detail.
			return null;
	}
}

/**
 * Subscribe a logger to the channel so every run-level event prints a line.
 * Errors and failures go to stderr; everything else to stdout. Returns the
 * channel's unsubscribe handle. `log`/`err` are injectable for tests.
 */
export function attachRunLogger(
	channel: TeamChannel,
	log: (line: string) => void = console.log,
	err: (line: string) => void = console.error,
): () => void {
	return channel.subscribe((event) => {
		const line = formatRunLogLine(event);
		if (line === null) return;
		if (event.type === "team_error" || event.type === "dag_failed") err(line);
		else log(line);
	});
}
