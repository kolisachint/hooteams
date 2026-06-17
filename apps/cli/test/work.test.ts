import { describe, expect, test } from "bun:test";
import { runLoop, submitAndFollow } from "../src/commands.js";

describe("runLoop", () => {
	test("stops as soon as the goal is verified", async () => {
		const goals: string[] = [];
		const met = await runLoop("ship it", 3, async (goal, iter) => {
			goals.push(goal);
			return { hasTasks: true, met: iter === 1 };
		});
		expect(met).toBe(true);
		expect(goals).toEqual(["ship it"]);
	});

	test("threads the unmet reason into later iterations, then exhausts", async () => {
		const goals: string[] = [];
		const met = await runLoop("ship it", 3, async (goal) => {
			goals.push(goal);
			return { hasTasks: true, met: false, reason: "missing tests" };
		});
		expect(met).toBe(false);
		expect(goals).toHaveLength(3);
		expect(goals[0]).toBe("ship it");
		expect(goals[1]).toContain("missing tests");
		expect(goals[2]).toContain("missing tests");
	});

	test("verifies on a later iteration and stops there", async () => {
		let calls = 0;
		const met = await runLoop("x", 5, async (_goal, iter) => {
			calls++;
			return { hasTasks: true, met: iter === 2, reason: "not yet" };
		});
		expect(met).toBe(true);
		expect(calls).toBe(2);
	});

	test("stops when an iteration yields no tasks", async () => {
		let calls = 0;
		const met = await runLoop("x", 5, async () => {
			calls++;
			return { hasTasks: false, met: false };
		});
		expect(met).toBe(false);
		expect(calls).toBe(1);
	});
});

describe("submitAndFollow", () => {
	function fakeServer(frames: string[]) {
		return Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.method === "POST" && url.pathname === "/runs") {
					return Response.json({ runId: "run-1" }, { status: 202 });
				}
				if (url.pathname === "/events") {
					return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
				}
				return new Response("not found", { status: 404 });
			},
		});
	}

	const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;

	test("captures the goal-validation reason from an orchestrator team_error", async () => {
		const server = fakeServer([
			frame({ type: "task_finished", taskId: "t", role: "r", status: "done", runId: "run-1" }),
			frame({ type: "team_error", error: "goal validation: missing tests", role: "orchestrator", agentId: "run-1" }),
			frame({ type: "dag_failed", runId: "run-1", role: "orchestrator", agentId: "run-1" }),
		]);
		try {
			const result = await submitAndFollow(`http://localhost:${server.port}`, { tasks: [] }, true);
			expect(result.failed).toBe(true);
			expect(result.validationReason).toBe("goal validation: missing tests");
		} finally {
			await server.stop(true);
		}
	});

	test("a clean settle is a verified success with no reason", async () => {
		const server = fakeServer([frame({ type: "dag_complete", runId: "run-1", role: "orchestrator", agentId: "run-1" })]);
		try {
			const result = await submitAndFollow(`http://localhost:${server.port}`, { tasks: [] }, true);
			expect(result.failed).toBe(false);
			expect(result.validationReason).toBeUndefined();
		} finally {
			await server.stop(true);
		}
	});

	test("a team_error for a different agent is ignored", async () => {
		const server = fakeServer([
			frame({ type: "team_error", error: "some worker blew up", role: "coder", agentId: "other-agent" }),
			frame({ type: "dag_failed", runId: "run-1", role: "orchestrator", agentId: "run-1" }),
		]);
		try {
			const result = await submitAndFollow(`http://localhost:${server.port}`, { tasks: [] }, true);
			expect(result.failed).toBe(true);
			expect(result.validationReason).toBeUndefined();
		} finally {
			await server.stop(true);
		}
	});
});
