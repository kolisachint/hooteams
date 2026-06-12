import { afterAll, describe, expect, test } from "bun:test";
import type { StreamFn } from "@kolisachint/hoocode-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, EventStream } from "@kolisachint/hoocode-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeHarnessFactory, HITL_SYSTEM_PROMPT } from "../src/node-harness.js";
import type { AgentEvent, RoleConfig, TaskNode } from "../src/types.js";

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

function createAssistantMessage(text: string): AssistantMessage {
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
	};
}

/** Replies "ok" to every run, recording each call's system prompt and messages. */
function echoStreamFn(calls: Array<{ systemPrompt: string; messages: unknown[] }>): StreamFn {
	return ((_model: any, context: any) => {
		calls.push({ systemPrompt: String(context.systemPrompt), messages: [...context.messages] });
		const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
		queueMicrotask(() => {
			(stream as any).push({ type: "done", reason: "stop", message: createAssistantMessage("ok") });
		});
		return stream;
	}) as StreamFn;
}

const node = (id: string, role: string): TaskNode => ({ id, role, deps: [], status: "idle" });

const roles: RoleConfig[] = [{ role: "ops", systemPrompt: "You run ops.", model: "fake-model" }];

const sessionsRoot = mkdtempSync(join(tmpdir(), "hooteams-node-harness-"));
afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));

describe("createNodeHarnessFactory", () => {
	test("rejects nodes whose role has no config", async () => {
		const factory = createNodeHarnessFactory({ roles, runId: "run-1", sessionsRoot });
		await expect(factory(node("x", "ghost"))).rejects.toThrow('No role config for "ghost". Configured roles: ops');
	});

	test("builds a working harness with the HITL protocol appended to the system prompt", async () => {
		const calls: Array<{ systemPrompt: string; messages: unknown[] }> = [];
		const factory = createNodeHarnessFactory({
			roles,
			runId: "run-2",
			sessionsRoot,
			resolveModel: () => fakeModel,
			streamFn: echoStreamFn(calls),
		});
		const handle = await factory(node("deploy", "ops"));
		expect(handle.sessionId).toBe("run-2-deploy");

		const events: string[] = [];
		handle.harness.subscribe((event: AgentEvent) => {
			events.push(event.type);
		});
		await handle.harness.prompt("deploy the app");

		expect(calls).toHaveLength(1);
		expect(calls[0]!.systemPrompt).toContain("You run ops.");
		expect(calls[0]!.systemPrompt).toContain("AWAITING_APPROVAL:");
		expect(calls[0]!.systemPrompt).toContain(HITL_SYSTEM_PROMPT.split("\n")[0]!);
		expect(events).toContain("message_end");
		expect(events).toContain("agent_end");
	});

	test("reopens the node's session on a second dispatch so the conversation survives", async () => {
		const calls: Array<{ systemPrompt: string; messages: unknown[] }> = [];
		const options = {
			roles,
			runId: "run-3",
			sessionsRoot,
			resolveModel: () => fakeModel,
			streamFn: echoStreamFn(calls),
		};
		const first = await createNodeHarnessFactory(options)(node("deploy", "ops"));
		await first.harness.prompt("deploy the app");

		// A fresh factory (as after a server restart) must find the same session.
		const second = await createNodeHarnessFactory(options)(node("deploy", "ops"));
		expect(second.sessionId).toBe(first.sessionId);
		await second.harness.prompt("yes");

		const resumed = calls[1]!;
		const texts = resumed.messages.map((message) => JSON.stringify(message)).join("\n");
		expect(texts).toContain("deploy the app");
		expect(texts).toContain("yes");
	});

	test("sanitizes task ids when naming node sessions", async () => {
		const factory = createNodeHarnessFactory({
			roles,
			runId: "run-4",
			sessionsRoot,
			resolveModel: () => fakeModel,
			streamFn: echoStreamFn([]),
		});
		const handle = await factory(node("ship/it now", "ops"));
		expect(handle.sessionId).toBe("run-4-ship-it-now");
	});
});
