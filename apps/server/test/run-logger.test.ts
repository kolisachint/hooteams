import { describe, expect, test } from "bun:test";
import type { TeamEvent } from "@kolisachint/hooteams-orchestrator";
import { TeamChannel } from "@kolisachint/hooteams-orchestrator";
import { attachRunLogger, formatRunLogLine } from "../src/run-logger.js";

const ts = Date.parse("2026-01-02T03:04:05.000Z");

describe("formatRunLogLine", () => {
	test("renders run-level events as one concise line each", () => {
		expect(formatRunLogLine({ type: "task_started", taskId: "build", role: "coder", agentId: "a1", ts })).toContain(
			"▶ task build (coder) started",
		);
		expect(formatRunLogLine({ type: "task_finished", taskId: "build", role: "coder", agentId: "a1", status: "done", ts })).toContain(
			"✓ task build done",
		);
		expect(formatRunLogLine({ type: "task_finished", taskId: "build", role: "coder", agentId: "a1", status: "error", ts })).toContain(
			"✗ task build error",
		);
		expect(
			formatRunLogLine({ type: "task_paused", taskId: "ship", role: "ops", agentId: "a1", question: "Ship it?", options: ["yes", "no"], ts }),
		).toContain("⏸ task ship paused — Ship it? [yes, no]");
		expect(formatRunLogLine({ type: "dag_complete", runId: "run-1", role: "orchestrator", agentId: "run-1", ts })).toContain(
			"✓ run run-1 complete",
		);
		expect(formatRunLogLine({ type: "dag_failed", runId: "run-1", role: "orchestrator", agentId: "run-1", ts })).toContain(
			"✗ run run-1 failed",
		);
		expect(formatRunLogLine({ type: "team_error", error: "boom", role: "orchestrator", agentId: "run-1", ts })).toContain(
			"⚠ error (orchestrator): boom",
		);
	});

	test("includes a sortable ISO timestamp prefix", () => {
		const line = formatRunLogLine({ type: "task_started", taskId: "x", role: "r", agentId: "a", ts });
		expect(line?.startsWith("2026-01-02T03:04:05.000Z")).toBe(true);
	});

	test("returns null for noisy per-token / snapshot events", () => {
		expect(formatRunLogLine({ type: "dag_snapshot", runId: "run-1", role: "orchestrator", agentId: "run-1", dag: {}, ts })).toBeNull();
		// A mirrored agent streaming event carries no run-level meaning here.
		expect(formatRunLogLine({ type: "message_update", role: "coder", agentId: "a1", ts } as unknown as TeamEvent)).toBeNull();
	});
});

describe("attachRunLogger", () => {
	test("logs run events from the channel and routes failures to stderr", () => {
		const channel = new TeamChannel();
		const out: string[] = [];
		const errs: string[] = [];
		const unsubscribe = attachRunLogger(
			channel,
			(line) => out.push(line),
			(line) => errs.push(line),
		);

		channel.publish({ type: "task_started", taskId: "build", role: "coder", agentId: "a1", ts });
		channel.publish({ type: "team_error", error: "boom", role: "orchestrator", agentId: "run-1", ts });
		channel.publish({ type: "dag_failed", runId: "run-1", role: "orchestrator", agentId: "run-1", ts });
		// A snapshot must not produce a line.
		channel.publish({ type: "dag_snapshot", runId: "run-1", role: "orchestrator", agentId: "run-1", dag: {}, ts });

		expect(out).toHaveLength(1);
		expect(out[0]).toContain("task build (coder) started");
		expect(errs).toHaveLength(2);
		expect(errs.some((line) => line.includes("boom"))).toBe(true);
		expect(errs.some((line) => line.includes("run run-1 failed"))).toBe(true);

		unsubscribe();
		channel.publish({ type: "task_started", taskId: "after", role: "coder", agentId: "a1", ts });
		expect(out).toHaveLength(1); // no new lines after unsubscribe
	});
});
