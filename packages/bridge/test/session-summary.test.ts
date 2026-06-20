import { describe, expect, test } from "bun:test";
import { DEFAULT_STALE_RUN_MS, summarizeSession } from "../src/session-summary.js";

/** Build a JSONL session log from custom entries. */
function jsonl(...entries: { customType: string; data: Record<string, unknown> }[]): string {
	return `${entries.map((e) => JSON.stringify({ type: "custom", ...e })).join("\n")}\n`;
}

describe("summarizeSession", () => {
	test("returns null when no entry carries a runId", () => {
		expect(summarizeSession("")).toBeNull();
		expect(summarizeSession("not json\n{}\n")).toBeNull();
		// custom entries without a runId anywhere
		expect(summarizeSession(jsonl({ customType: "noise", data: { foo: 1 } }))).toBeNull();
	});

	test("digests goal, counts, startedAt; status is running until run_end", () => {
		// now within the staleness window of the last entry, so it stays "running".
		const running = summarizeSession(
			jsonl(
				{ customType: "run_config", data: { runId: "r1", goal: "ship it", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }] } },
				{ customType: "run_start", data: { runId: "r1", ts: 1234 } },
				{ customType: "dag_state", data: { runId: "r1", ts: 1240, dag: { a: { status: "done" }, b: { status: "running" }, c: { status: "idle" } } } },
			),
			1240,
		);
		expect(running).toEqual({ runId: "r1", goal: "ship it", status: "running", done: 1, total: 3, startedAt: 1234 });
	});

	test("reconciles an orphaned run (no run_end, idle past the window) to interrupted (L2)", () => {
		const log = jsonl(
			{ customType: "run_config", data: { runId: "r-orphan", tasks: [{ id: "a" }, { id: "b" }] } },
			{ customType: "run_start", data: { runId: "r-orphan", ts: 1000 } },
			{ customType: "task_start", data: { runId: "r-orphan", taskId: "a", ts: 1500 } },
			{ customType: "dag_state", data: { runId: "r-orphan", ts: 1500, dag: { a: { status: "running" }, b: { status: "idle" } } } },
			// no run_end — the process died here
		);
		// Plenty past the staleness window from the last entry's ts (1500).
		const stale = summarizeSession(log, 1500 + DEFAULT_STALE_RUN_MS + 1);
		expect(stale).toMatchObject({ runId: "r-orphan", status: "interrupted", done: 0, total: 2 });
		// Just inside the window it's still considered running (between writes).
		const fresh = summarizeSession(log, 1500 + DEFAULT_STALE_RUN_MS - 1);
		expect(fresh).toMatchObject({ status: "running" });
	});

	test("a completed run is never reconciled, even long after its last write", () => {
		const log = jsonl(
			{ customType: "run_config", data: { runId: "r-done", tasks: [{ id: "a" }] } },
			{ customType: "run_start", data: { runId: "r-done", ts: 1000 } },
			{ customType: "run_end", data: { runId: "r-done", status: "complete", ts: 1100 } },
		);
		expect(summarizeSession(log, 1100 + DEFAULT_STALE_RUN_MS * 100)).toMatchObject({ status: "done" });
	});

	test("run_end sets done/error; the latest dag_state wins for the count", () => {
		const done = summarizeSession(
			jsonl(
				{ customType: "run_config", data: { runId: "r2", tasks: [{ id: "a" }, { id: "b" }] } },
				{ customType: "dag_state", data: { runId: "r2", dag: { a: { status: "done" }, b: { status: "running" } } } },
				{ customType: "dag_state", data: { runId: "r2", dag: { a: { status: "done" }, b: { status: "done" } } } },
				{ customType: "run_end", data: { runId: "r2", status: "complete" } },
			),
		);
		expect(done).toMatchObject({ status: "done", done: 2, total: 2 });

		const failed = summarizeSession(
			jsonl(
				{ customType: "run_config", data: { runId: "r3", tasks: [{ id: "a" }] } },
				{ customType: "run_end", data: { runId: "r3", status: "failed" } },
			),
		);
		expect(failed).toMatchObject({ status: "error" });
	});

	test("total falls back to dag size when run_config has no tasks", () => {
		const s = summarizeSession(
			jsonl(
				{ customType: "run_start", data: { runId: "r4", ts: 9 } },
				{ customType: "dag_state", data: { runId: "r4", dag: { a: { status: "done" }, b: { status: "idle" } } } },
			),
		);
		expect(s).toMatchObject({ runId: "r4", total: 2, done: 1 });
	});

	test("skips malformed lines but still summarizes the rest", () => {
		const raw = `garbage\n${JSON.stringify({ type: "custom", customType: "run_config", data: { runId: "r5", tasks: [{ id: "a" }] } })}\n{bad json\n`;
		expect(summarizeSession(raw)).toMatchObject({ runId: "r5", total: 1 });
	});
});
