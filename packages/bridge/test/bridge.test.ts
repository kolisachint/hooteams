import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentEvent,
	type Subscribable,
	Team,
	TeamChannel,
} from "@kolisachint/hooteams-orchestrator";
import { createRouter, RunRejectedError, type StartRunRequest } from "../src/router.js";
import { SSEBridge } from "../src/sse.js";

class FakeAgent implements Subscribable {
	private listeners = new Set<(event: AgentEvent) => void | Promise<void>>();

	subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

const fakeModel = {
	id: "fake-model",
	name: "fake",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
} as any;

function toolEvent(i: number): AgentEvent {
	return { type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "noop", args: { i } };
}

/** Read SSE data frames off a fetch response until `count` events arrive. */
async function readEvents(response: Response, count: number, timeoutMs = 2000): Promise<any[]> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const events: any[] = [];
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (events.length < count) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${events.length}/${count} events`);
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
		let index: number;
		while ((index = text.indexOf("\n\n")) !== -1) {
			const frame = text.slice(0, index);
			text = text.slice(index + 2);
			if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice("data: ".length)));
		}
	}
	await reader.cancel();
	return events;
}

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

function startServer(routerOptions?: Parameters<typeof createRouter>[3]) {
	const channel = new TeamChannel();
	const team = new Team(channel, { resolveModel: () => fakeModel });
	const bridge = new SSEBridge(channel);
	const router = createRouter(team, channel, bridge, routerOptions);
	server = Bun.serve({ port: 0, fetch: (request) => router.fetch(request) });
	const base = `http://localhost:${server.port}`;
	return { channel, team, bridge, base };
}

describe("SSE replay + live ordering", () => {
	test("a client attaching mid-run gets replay of past events, then live events, in order", async () => {
		const { channel, base } = startServer();
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);

		// Events 1-3 happen before anyone is watching.
		agent.emit(toolEvent(1));
		agent.emit(toolEvent(2));
		agent.emit(toolEvent(3));

		const response = await fetch(`${base}/events/coder`);
		expect(response.headers.get("content-type")).toBe("text/event-stream");

		const eventsPromise = readEvents(response, 5);
		// Give the stream a beat to flush the replay before going live.
		await new Promise((resolve) => setTimeout(resolve, 50));
		agent.emit(toolEvent(4));
		agent.emit(toolEvent(5));

		const events = await eventsPromise;
		expect(events.map((event) => event.toolCallId)).toEqual([
			"call-1",
			"call-2",
			"call-3",
			"call-4",
			"call-5",
		]);
		expect(events.every((event) => event.role === "coder" && event.agentId === "id-1")).toBe(true);
	});

	test("an idle stream emits SSE comment heartbeats so the connection stays warm", async () => {
		const channel = new TeamChannel();
		const bridge = new SSEBridge(channel, 20); // 20ms heartbeat for the test
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);

		// Read the raw stream so comment frames are visible (the data-frame helper
		// skips them). With no events flowing, only heartbeats should arrive.
		const reader = bridge.stream("coder").getReader();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + 1000;
		while (!text.includes(": ping\n\n") && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		expect(text).toContain(": ping\n\n");
		await reader.cancel();
	});

	test("/events without a role merges all agents; ?replay=N trims history", async () => {
		const { channel, base } = startServer();
		const coder = new FakeAgent();
		const tester = new FakeAgent();
		channel.attach("coder", "id-1", coder);
		channel.attach("tester", "id-2", tester);

		coder.emit(toolEvent(1));
		tester.emit(toolEvent(2));

		const all = await readEvents(await fetch(`${base}/events`), 2);
		expect(all.map((event) => event.role)).toEqual(["coder", "tester"]);

		coder.emit(toolEvent(3));
		const trimmed = await readEvents(await fetch(`${base}/events/coder?replay=1`), 1);
		expect(trimmed[0].toolCallId).toBe("call-3");
	});
});

describe("routes", () => {
	test("GET /health", async () => {
		const { base } = startServer();
		expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
	});

	test("POST /steer queues into the right agent and 404s for unknown roles", async () => {
		const { team, base } = startServer();
		team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });

		const ok = await fetch(`${base}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role: "coder", message: "focus on token refresh" }),
		});
		expect(ok.status).toBe(200);
		// Nudging an idle, empty agent starts a run with the message as prompt.
		const agent = team.get("coder")!;
		await agent.waitForIdle();
		const first = agent.state.messages[0] as { role: string; content: Array<{ type: string; text?: string }> };
		expect(first.role).toBe("user");
		expect(first.content[0]?.text).toBe("focus on token refresh");

		const missing = await fetch(`${base}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role: "ghost", message: "hello" }),
		});
		expect(missing.status).toBe(404);

		const invalid = await fetch(`${base}/steer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ role: "coder" }),
		});
		expect(invalid.status).toBe(400);
	});

	test("GET /status reports each agent's status and last event type", async () => {
		const { team, channel, base } = startServer();
		team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });
		channel.publish({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "noop",
			args: {},
			role: "coder",
			agentId: channel.agentId("coder")!,
			ts: Date.now(),
		});

		const status = (await (await fetch(`${base}/status`)).json()) as Record<string, any>;
		expect(status.coder.status).toBe("tool");
		expect(status.coder.lastEventType).toBe("tool_execution_start");
	});

	test("unknown routes 404", async () => {
		const { base } = startServer();
		expect((await fetch(`${base}/nope`)).status).toBe(404);
	});
});

describe("HITL routes", () => {
	function fakeRun() {
		const resumed: Array<{ taskId: string; option: string; feedback?: string }> = [];
		const run = {
			runId: "run-1",
			pending: [{ taskId: "deploy", question: "Ship it?", options: ["yes", "no"] }],
			resume(taskId: string, option: string, feedback?: string): boolean {
				if (!this.pending.some((request) => request.taskId === taskId)) return false;
				this.pending = this.pending.filter((request) => request.taskId !== taskId);
				resumed.push({ taskId, option, feedback });
				return true;
			},
			pendingApprovals() {
				return this.pending;
			},
			trace(runId?: string) {
				return Promise.resolve({ runId: runId ?? this.runId, status: "running", tasks: [] });
			},
		};
		return { run, resumed };
	}

	test("404 on all HITL routes while no run is attached", async () => {
		const { base } = startServer({ hitl: () => undefined });
		expect((await fetch(`${base}/tasks/pending`)).status).toBe(404);
		expect((await fetch(`${base}/trace`)).status).toBe(404);
		expect((await fetch(`${base}/runs/run-1/trace`)).status).toBe(404);
		const resume = await fetch(`${base}/tasks/deploy/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ option: "yes" }),
		});
		expect(resume.status).toBe(404);
	});

	test("GET /tasks/pending lists open gates with the run id", async () => {
		const { run } = fakeRun();
		const { base } = startServer({ hitl: () => run });
		expect(await (await fetch(`${base}/tasks/pending`)).json()).toEqual({
			runId: "run-1",
			pending: [{ taskId: "deploy", question: "Ship it?", options: ["yes", "no"] }],
		});
	});

	test("POST /tasks/:id/resume answers the gate; stale answers 409; bad bodies 400", async () => {
		const { run, resumed } = fakeRun();
		const { base } = startServer({ hitl: () => run });

		const ok = await fetch(`${base}/tasks/deploy/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ option: "yes", feedback: "ship it" }),
		});
		expect(await ok.json()).toEqual({ ok: true, taskId: "deploy" });
		expect(resumed).toEqual([{ taskId: "deploy", option: "yes", feedback: "ship it" }]);

		// first answer won; the second surface gets a conflict
		const stale = await fetch(`${base}/tasks/deploy/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ option: "no" }),
		});
		expect(stale.status).toBe(409);

		const invalid = await fetch(`${base}/tasks/deploy/resume`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "missing option" }),
		});
		expect(invalid.status).toBe(400);
	});

	test("GET /trace and /runs/:id/trace return the run trace", async () => {
		const { run } = fakeRun();
		const { base } = startServer({ hitl: () => run });
		expect(await (await fetch(`${base}/trace`)).json()).toMatchObject({ runId: "run-1" });
		expect(await (await fetch(`${base}/runs/run-7/trace`)).json()).toMatchObject({ runId: "run-7" });
	});
});

describe("POST /runs", () => {
	const post = (base: string, body: unknown) =>
		fetch(`${base}/runs`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		});

	test("404 when the host wired no startRun handler", async () => {
		const { base } = startServer();
		expect((await post(base, { tasks: [{ id: "a", role: "ops" }] })).status).toBe(404);
	});

	test("202 with the run id; the handler receives the parsed request", async () => {
		const received: StartRunRequest[] = [];
		const { base } = startServer({
			startRun: async (request) => {
				received.push(request);
				return { runId: "run-42" };
			},
		});
		const response = await post(base, { tasks: [{ id: "a", role: "ops", prompt: "go", deps: [] }] });
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ runId: "run-42" });
		expect(received).toEqual([{ tasks: [{ id: "a", role: "ops", prompt: "go", deps: [] }] }]);
	});

	test("400 on malformed bodies without invoking the handler", async () => {
		let calls = 0;
		const { base } = startServer({
			startRun: async () => {
				calls++;
				return { runId: "x" };
			},
		});
		expect((await post(base, "not json")).status).toBe(400);
		expect((await post(base, {})).status).toBe(400);
		expect((await post(base, { tasks: [] })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a" }] })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a", role: "ops", prompt: 7 }] })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a", role: "ops", deps: [1] }] })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a", role: "ops", retries: -1 }] })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a", role: "ops", retries: 1.5 }] })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a", role: "ops" }], goal: 7 })).status).toBe(400);
		expect((await post(base, { tasks: [{ id: "a", role: "ops" }], roles: [{ role: "ops" }] })).status).toBe(400);
		expect(calls).toBe(0);
	});

	test("goal, per-run roles, and retries pass through to the handler", async () => {
		const received: StartRunRequest[] = [];
		const { base } = startServer({
			startRun: async (request) => {
				received.push(request);
				return { runId: "run-43" };
			},
		});
		const body = {
			goal: "ship the haiku",
			roles: [{ role: "poet", systemPrompt: "write poems", model: "claude-sonnet-4-5" }],
			tasks: [{ id: "a", role: "poet", prompt: "go", retries: 2 }],
		};
		expect((await post(base, body)).status).toBe(202);
		expect(received).toEqual([body]);
	});

	test("RunRejectedError surfaces with its status; other errors 500", async () => {
		let error: Error = new RunRejectedError("A run is already active", 409);
		const { base } = startServer({
			startRun: async () => {
				throw error;
			},
		});
		const conflict = await post(base, { tasks: [{ id: "a", role: "ops" }] });
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "A run is already active" });

		error = new RunRejectedError('Unknown role "ghost"', 400);
		expect((await post(base, { tasks: [{ id: "a", role: "ghost" }] })).status).toBe(400);

		error = new Error("disk on fire");
		expect((await post(base, { tasks: [{ id: "a", role: "ops" }] })).status).toBe(500);
	});
});
