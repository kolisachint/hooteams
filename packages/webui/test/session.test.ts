import { describe, expect, test } from "bun:test";
import { parseSession } from "../src/lib/session";

/** One JSONL line per custom session entry, as the orchestrator persists them. */
function line(customType: string, data: Record<string, unknown>): string {
	return JSON.stringify({ type: "custom", customType, data });
}

describe("parseSession replay", () => {
	test("surfaces a marker-driven pause on a non-gated node as a pending gate", () => {
		const jsonl = [
			line("run_config", {
				runId: "run-1",
				goal: "ship it",
				// `scope` is NOT statically gated — the pause is marker-driven.
				tasks: [{ id: "scope", role: "scope" }],
			}),
			line("run_start", { runId: "run-1", ts: 1 }),
			line("task_start", { runId: "run-1", taskId: "scope" }),
			line("approval_request", {
				runId: "run-1",
				taskId: "scope",
				question: "What is the current goal for this scope lock?",
				options: ["Please provide the goal description.", "Continue with a default goal."],
				ts: 2,
			}),
			// Display-only mirror (type custom_message) must be ignored by the parser.
			JSON.stringify({
				type: "custom_message",
				customType: "approval_request",
				content: "[scope] ...",
				display: true,
			}),
			line("dag_state", { runId: "run-1", dag: { scope: { role: "scope", deps: [], status: "paused" } }, ts: 3 }),
		].join("\n");

		const info = parseSession(jsonl);
		expect(info).not.toBeNull();
		// A paused node maps to "pending" (was previously dropped to "idle").
		expect(info?.dag.scope?.status).toBe("pending");
		// The open gate is carried so the UI can render the question + options.
		expect(info?.pending?.scope).toEqual({
			taskId: "scope",
			question: "What is the current goal for this scope lock?",
			options: ["Please provide the goal description.", "Continue with a default goal."],
		});
	});

	test("an answered gate leaves no pending approval", () => {
		const jsonl = [
			line("run_config", { runId: "run-2", tasks: [{ id: "scope", role: "scope" }] }),
			line("approval_request", { runId: "run-2", taskId: "scope", question: "q?", options: ["a", "b"], ts: 1 }),
			line("approval_response", { runId: "run-2", taskId: "scope", chosenOption: "a", ts: 2 }),
		].join("\n");

		const info = parseSession(jsonl);
		expect(info?.pending).toBeUndefined();
	});
});
