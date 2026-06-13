import { describe, expect, test } from "bun:test";
import type { StreamFn } from "@kolisachint/hoocode-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream } from "@kolisachint/hoocode-ai";
import { EventStream } from "@kolisachint/hoocode-ai";
import { TeamChannel } from "../src/channel.js";
import { TaskDag } from "@kolisachint/hooteams-dag";
import { Orchestrator } from "../src/orchestrator.js";
import { Team } from "../src/team.js";
import type { TeamEvent } from "../src/types.js";

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

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessageStream(): AssistantMessageEventStream {
	return new MockAssistantStream() as unknown as AssistantMessageEventStream;
}

function createAssistantMessage(content: AssistantMessage["content"], stopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fake-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stopReason as AssistantMessage["stopReason"],
		timestamp: Date.now(),
	};
}

/**
 * Finishes every run with a one-line text message. Records the final (user)
 * message of each run's context so tests can assert dispatch order, and
 * throws when the agent's system prompt contains "FAIL" to simulate a model
 * failure for that role.
 */
function echoStreamFn(calls: string[]): StreamFn {
	return ((_model: any, context: any) => {
		if (String(context.systemPrompt).includes("FAIL")) {
			throw new Error("model exploded");
		}
		calls.push(JSON.stringify(context.messages[context.messages.length - 1] ?? null));
		const stream = createAssistantMessageStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "ok" }]) });
		});
		return stream;
	}) as StreamFn;
}

function indexOfCall(calls: string[], taskId: string): number {
	return calls.findIndex((call) => call.includes(taskId));
}

function createTeam(calls: string[] = []): { channel: TeamChannel; team: Team } {
	const channel = new TeamChannel();
	const team = new Team(channel, { resolveModel: () => fakeModel, streamFn: echoStreamFn(calls) });
	return { channel, team };
}

describe("Orchestrator", () => {
	test("resolves immediately for an empty dag", async () => {
		const { channel, team } = createTeam();
		await new Orchestrator(team, new TaskDag(), channel).start();
	});

	test("runs nodes in dependency order and records results", async () => {
		const calls: string[] = [];
		const { channel, team } = createTeam(calls);
		team.spawn({ role: "a", systemPrompt: "agent a", model: "fake-model" });
		team.spawn({ role: "b", systemPrompt: "agent b", model: "fake-model" });
		const dag = new TaskDag();
		dag.add({ id: "t1", role: "a" });
		dag.add({ id: "t2", role: "b", deps: ["t1"] });

		await new Orchestrator(team, dag, channel).start();

		expect(dag.get("t1")?.status).toBe("done");
		expect(dag.get("t2")?.status).toBe("done");
		expect(indexOfCall(calls, "t1")).toBeGreaterThanOrEqual(0);
		expect(indexOfCall(calls, "t1")).toBeLessThan(indexOfCall(calls, "t2"));
		// markDone stored the run's messages on the node
		expect(JSON.stringify(dag.get("t1")?.results)).toContain("ok");
	});

	test("completing a node dispatches everything it unblocked", async () => {
		const calls: string[] = [];
		const { channel, team } = createTeam(calls);
		for (const role of ["planner", "coder", "writer", "tester"]) {
			team.spawn({ role, systemPrompt: `agent ${role}`, model: "fake-model" });
		}
		const dag = new TaskDag();
		dag.add({ id: "plan", role: "planner" });
		dag.add({ id: "code", role: "coder", deps: ["plan"] });
		dag.add({ id: "docs", role: "writer", deps: ["plan"] });
		dag.add({ id: "test", role: "tester", deps: ["code", "docs"] });

		await new Orchestrator(team, dag, channel).start();

		expect(dag.all().map((node) => node.status)).toEqual(["done", "done", "done", "done"]);
		expect(indexOfCall(calls, "plan")).toBeLessThan(indexOfCall(calls, "code"));
		expect(indexOfCall(calls, "plan")).toBeLessThan(indexOfCall(calls, "docs"));
		expect(indexOfCall(calls, "test")).toBeGreaterThan(indexOfCall(calls, "code"));
		expect(indexOfCall(calls, "test")).toBeGreaterThan(indexOfCall(calls, "docs"));
	});

	test("a role runs one task at a time and still completes all of them", async () => {
		const calls: string[] = [];
		const { channel, team } = createTeam(calls);
		team.spawn({ role: "w", systemPrompt: "worker", model: "fake-model" });
		const dag = new TaskDag();
		dag.add({ id: "t1", role: "w" });
		dag.add({ id: "t2", role: "w" });
		const agentEnds: TeamEvent[] = [];
		channel.subscribe((event) => {
			if (event.type === "agent_end" && event.role === "w") agentEnds.push(event);
		});

		await new Orchestrator(team, dag, channel).start();

		expect(dag.get("t1")?.status).toBe("done");
		expect(dag.get("t2")?.status).toBe("done");
		// two separate runs, not one run with a merged steering message
		expect(agentEnds).toHaveLength(2);
		expect(calls).toHaveLength(2);
	});

	test("a failing run marks the task failed, blocks dependents, and still resolves", async () => {
		const { channel, team } = createTeam();
		team.spawn({ role: "good", systemPrompt: "agent good", model: "fake-model" });
		team.spawn({ role: "bad", systemPrompt: "FAIL agent", model: "fake-model" });
		const dag = new TaskDag();
		dag.add({ id: "t1", role: "good" });
		dag.add({ id: "t2", role: "bad", deps: ["t1"] });
		dag.add({ id: "t3", role: "good", deps: ["t2"] });

		await new Orchestrator(team, dag, channel).start();

		expect(dag.get("t1")?.status).toBe("done");
		expect(dag.get("t2")?.status).toBe("error");
		expect(dag.get("t3")?.status).toBe("idle");
		expect(dag.blocked().map((node) => node.id)).toEqual(["t3"]);
		expect(dag.isComplete()).toBe(true);
	});

	test("a steer rejection surfaces as team_error and fails the task", async () => {
		const { channel, team } = createTeam();
		const agent = team.spawn({ role: "w", systemPrompt: "worker", model: "fake-model" });
		(agent as any).prompt = () => Promise.reject(new Error("boom"));
		const dag = new TaskDag();
		dag.add({ id: "t1", role: "w" });
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		await new Orchestrator(team, dag, channel).start();

		expect(dag.get("t1")?.status).toBe("error");
		const errorEvent = events.find((event) => event.type === "team_error");
		expect(errorEvent).toBeDefined();
		expect((errorEvent as any).error).toBe("boom");
		expect((errorEvent as any).role).toBe("w");
	});

	test("a node whose role has no agent fails instead of hanging", async () => {
		const { channel, team } = createTeam();
		const dag = new TaskDag();
		dag.add({ id: "t1", role: "ghost" });
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		await new Orchestrator(team, dag, channel).start();

		expect(dag.get("t1")?.status).toBe("error");
		expect(events.some((event) => event.type === "team_error" && event.role === "ghost")).toBe(true);
	});
});

describe("team.steer error reporting", () => {
	test("publishes team_error instead of swallowing prompt rejections", async () => {
		const channel = new TeamChannel();
		const team = new Team(channel, { resolveModel: () => fakeModel });
		const agent = team.spawn({ role: "w", systemPrompt: "worker", model: "fake-model" });
		(agent as any).prompt = () => Promise.reject(new Error("boom"));
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		team.steer("w", "do it");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const errorEvent = events.find((event) => event.type === "team_error");
		expect(errorEvent).toBeDefined();
		expect((errorEvent as any).error).toBe("boom");
		expect((errorEvent as any).role).toBe("w");
		expect(team.status().w).toBe("error");
	});
});
