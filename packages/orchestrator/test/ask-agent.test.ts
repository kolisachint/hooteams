import { describe, expect, test } from "bun:test";
import type { StreamFn } from "@kolisachint/hoocode-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	EventStream,
} from "@kolisachint/hoocode-ai";
import { TeamChannel } from "../src/channel.js";
import { askAgent, createAskAgentTool, Planner } from "../src/planner.js";
import { Team } from "../src/team.js";

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

function assistantReply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

/** Every run replies "answer: <last user text>". */
const echoStreamFn: StreamFn = ((_model: any, context: any) => {
	const last = context.messages[context.messages.length - 1] as { content?: Array<{ type: string; text?: string }> };
	const text = (last?.content ?? [])
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
	const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
	queueMicrotask(() => {
		(stream as any).push({ type: "done", reason: "stop", message: assistantReply(`answer: ${text}`) });
	});
	return stream;
}) as StreamFn;

/** A stream that never completes, for timeout tests. */
const stuckStreamFn: StreamFn = (() => new MockAssistantStream() as unknown as AssistantMessageEventStream) as StreamFn;

describe("ask_agent", () => {
	test("resolves with the target agent's reply to the question", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
		team.spawn({ role: "security-auditor", systemPrompt: "audit", model: "fake-model" });
		const tool = createAskAgentTool(team, { selfRole: "coder" });

		const result = await tool.execute("call-1", { role: "security-auditor", question: "is this safe?" } as any);
		expect(JSON.stringify(result.content)).toContain("answer: is this safe?");
		expect(result.details).toMatchObject({ role: "security-auditor", answered: true });
	});

	test("works against an idle agent with prior history (steer + continue path)", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
		const agent = team.spawn({ role: "reviewer", systemPrompt: "review", model: "fake-model" });
		await agent.prompt("warm up");

		const answer = await askAgent(team, "reviewer", "second question");
		expect(answer).toBe("answer: second question");
	});

	test("correlates the answer to the asked question across prior unrelated replies", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
		const agent = team.spawn({ role: "helper", systemPrompt: "help", model: "fake-model" });
		// Two prior runs leave unrelated assistant replies in the transcript; the
		// answer must be the reply that follows our own question, not the latest
		// reply that happened to be there.
		await agent.prompt("first unrelated task");
		await agent.prompt("second unrelated task");

		const answer = await askAgent(team, "helper", "the real question");
		expect(answer).toBe("answer: the real question");
	});

	test("rejects unknown roles with the available roles listed", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
		team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });
		const tool = createAskAgentTool(team);
		expect(tool.execute("call-1", { role: "ghost", question: "hi" } as any)).rejects.toThrow(/No agent for role "ghost".*coder/);
	});

	test("rejects asking your own role (it would deadlock)", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
		team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });
		const tool = createAskAgentTool(team, { selfRole: "coder" });
		expect(tool.execute("call-1", { role: "coder", question: "hi" } as any)).rejects.toThrow(/own role "coder"/);
	});

	test("times out when the target never answers", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: stuckStreamFn });
		team.spawn({ role: "slow", systemPrompt: "slow", model: "fake-model" });
		expect(askAgent(team, "slow", "anyone there?", 25)).rejects.toThrow(/Timed out after 25ms/);
		team.kill("slow");
	});

	test("a live planner gets ask_agent; a dryRun planner does not", () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
		const live = new Planner({ team });
		expect(live.agent.state.tools.map((tool) => tool.name)).toContain("ask_agent");

		const dry = new Planner({ team: new Team(new TeamChannel(), { resolveModel: () => fakeModel }), dryRun: true });
		expect(dry.agent.state.tools.map((tool) => tool.name)).not.toContain("ask_agent");
	});

	test("planner with memory gets memory_read and memory_write tools", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { TeamMemory } = await import("../src/memory.js");
		const memoryRoot = mkdtempSync(join(tmpdir(), "planner-memory-"));
		try {
			const memory = new TeamMemory({ memoryRoot, project: "p" });
			const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: echoStreamFn });
			const planner = new Planner({ team, memory });
			const names = planner.agent.state.tools.map((tool) => tool.name);
			expect(names).toContain("memory_read");
			expect(names).toContain("memory_write");
		} finally {
			rmSync(memoryRoot, { recursive: true, force: true });
		}
	});
});
