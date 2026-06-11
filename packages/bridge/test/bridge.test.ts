import { afterEach, describe, expect, test } from "bun:test";
import {
	type AgentEvent,
	type Subscribable,
	Team,
	TeamChannel,
} from "@kolisachint/hooteams-orchestrator";
import { createRouter } from "../src/router.js";
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

function startServer() {
	const channel = new TeamChannel();
	const team = new Team(channel, { resolveModel: () => fakeModel });
	const bridge = new SSEBridge(channel);
	const router = createRouter(team, channel, bridge);
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
