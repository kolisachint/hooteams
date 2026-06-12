import { afterAll, describe, expect, test } from "bun:test";
import type { StreamFn } from "@kolisachint/hoocode-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	EventStream,
} from "@kolisachint/hoocode-ai";
import {
	type AgentEvent,
	type AgentMessage,
	InMemorySessionRepo,
	TaskDag,
	type TaskNode,
	TeamOrchestrator,
	type TraceRun,
} from "@kolisachint/hooteams-orchestrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

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

describe("validateConfig", () => {
	test("accepts a valid config", () => {
		const config = validateConfig(
			{ team: [{ role: "coder", model: "m", systemPrompt: "s" }], maxConcurrent: 2 },
			"test",
		);
		expect(config.team).toHaveLength(1);
		expect(config.maxConcurrent).toBe(2);
	});

	test("rejects missing team array and malformed entries", () => {
		expect(() => validateConfig({}, "test")).toThrow(/"team" must be an array/);
		expect(() => validateConfig({ team: [{ role: "x" } as any] }, "test")).toThrow(/needs string fields/);
		expect(() =>
			validateConfig(
				{
					team: [
						{ role: "x", model: "m", systemPrompt: "s" },
						{ role: "x", model: "m", systemPrompt: "s" },
					],
				},
				"test",
			),
		).toThrow(/duplicate role "x"/);
	});

	test("fills model, provider, and thinkingLevel from defaults", () => {
		const config = validateConfig(
			{
				defaults: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "low" },
				team: [
					{ role: "planner", systemPrompt: "plan" },
					{ role: "coder", systemPrompt: "code", model: "claude-haiku-4-5", provider: "other", thinkingLevel: "off" },
				],
			},
			"test",
		);
		expect(config.team[0]).toMatchObject({
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			thinkingLevel: "low",
		});
		expect(config.team[1]).toMatchObject({ model: "claude-haiku-4-5", provider: "other", thinkingLevel: "off" });
	});

	test("rejects a role without model when defaults.model is missing", () => {
		expect(() => validateConfig({ team: [{ role: "x", systemPrompt: "s" }] }, "test")).toThrow(
			/role "x" has no "model"/,
		);
	});
});

describe("startServer", () => {
	test("spawns the configured team and serves status until /stop", async () => {
		const running = startServer(
			{ team: [{ role: "coder", model: "fake-model", systemPrompt: "code" }] },
			{ port: 0, teamOptions: { resolveModel: () => fakeModel } },
		);
		const base = `http://localhost:${running.port}`;

		expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
		const status = (await (await fetch(`${base}/status`)).json()) as Record<string, { status: string }>;
		expect(status.coder?.status).toBe("idle");

		const stopResponse = await fetch(`${base}/stop`, { method: "POST" });
		expect(((await stopResponse.json()) as { stopping: boolean }).stopping).toBe(true);

		// Server should refuse connections shortly after.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect(fetch(`${base}/health`)).rejects.toThrow();
	});

	test("attachOrchestrator exposes a live run on the HITL routes", async () => {
		const assistant = (text: string): AgentMessage =>
			({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() }) as unknown as AgentMessage;
		// Minimal NodeHarness: first prompt pauses on the marker, the resume prompt finishes.
		const createHarness = (node: TaskNode) => {
			const listeners = new Set<(event: AgentEvent) => Promise<void> | void>();
			const emit = (event: AgentEvent) => {
				for (const listener of listeners) void listener(event);
			};
			let calls = 0;
			return {
				harness: {
					prompt(text: string): Promise<unknown> {
						const message = calls++ === 0 ? assistant("AWAITING_APPROVAL: Ship it? | yes, no") : assistant(`did ${text}`);
						return Promise.resolve().then(() => {
							emit({ type: "message_end", message });
							emit({ type: "agent_end", messages: [message] });
						});
					},
					steer(): void {
						throw new Error("Cannot steer while idle");
					},
					subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
				sessionId: `session-${node.id}`,
			};
		};

		const running = startServer(
			{ team: [{ role: "ops", model: "fake-model", systemPrompt: "ops" }] },
			{ port: 0, teamOptions: { resolveModel: () => fakeModel } },
		);
		const base = `http://localhost:${running.port}`;
		try {
			// No run attached yet: the contract routes 404.
			expect((await fetch(`${base}/tasks/pending`)).status).toBe(404);

			const session = await new InMemorySessionRepo().create();
			const dag = new TaskDag();
			dag.add({ id: "deploy", role: "ops" });
			const orchestrator = new TeamOrchestrator(dag, {
				session,
				channel: running.channel,
				createHarness,
				runId: "run-e2e",
			});
			running.attachOrchestrator(orchestrator, session);
			const run = orchestrator.run();

			// Wait for the gate to open, as a hoocode --team client would after task_paused.
			let pending: { runId: string; pending: Array<{ taskId: string; question: string; options: string[] }> };
			do {
				await new Promise((resolve) => setTimeout(resolve, 5));
				pending = (await (await fetch(`${base}/tasks/pending`)).json()) as typeof pending;
			} while (pending.pending.length === 0);
			expect(pending).toEqual({
				runId: "run-e2e",
				pending: [{ taskId: "deploy", question: "Ship it?", options: ["yes", "no"] }],
			});

			const resume = await fetch(`${base}/tasks/deploy/resume`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ option: "yes" }),
			});
			expect(await resume.json()).toEqual({ ok: true, taskId: "deploy" });
			await run;

			const trace = (await (await fetch(`${base}/trace`)).json()) as TraceRun;
			expect(trace.runId).toBe("run-e2e");
			expect(trace.status).toBe("complete");
			expect(trace.tasks[0]).toMatchObject({ taskId: "deploy", role: "ops", status: "done" });
			expect(trace.tasks[0]?.approvals[0]).toMatchObject({ question: "Ship it?", chosenOption: "yes" });
		} finally {
			await running.stop();
		}
	});
});

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event: AssistantMessageEvent) => event.type === "done" || event.type === "error",
			(event: AssistantMessageEvent) => {
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

/**
 * Plays an agent that opens an approval gate: any run whose last user message
 * is not "yes" replies with the AWAITING_APPROVAL marker; the "yes" answer
 * gets "shipped".
 */
const gateStreamFn: StreamFn = ((_model: any, context: any) => {
	const last = context.messages[context.messages.length - 1] as { content?: Array<{ type: string; text?: string }> };
	const text = (last?.content ?? [])
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("\n");
	const reply = text.trim() === "yes" ? "shipped" : "AWAITING_APPROVAL: Ship it? | yes, no";
	const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
	queueMicrotask(() => {
		(stream as any).push({ type: "done", reason: "stop", message: assistantReply(reply) });
	});
	return stream;
}) as StreamFn;

type PendingResponse = { runId: string; pending: Array<{ taskId: string; question: string; options: string[] }> };

async function pollPending(base: string): Promise<PendingResponse> {
	while (true) {
		const response = await fetch(`${base}/tasks/pending`);
		if (response.ok) {
			const data = (await response.json()) as PendingResponse;
			if (data.pending.length > 0) return data;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function pollTraceSettled(base: string): Promise<TraceRun> {
	while (true) {
		const trace = (await (await fetch(`${base}/trace`)).json()) as TraceRun;
		if (trace.status !== "running") return trace;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("POST /runs end to end", () => {
	const sessionsRoot = mkdtempSync(join(tmpdir(), "hooteams-server-runs-"));
	afterAll(() => rmSync(sessionsRoot, { recursive: true, force: true }));
	const config = { team: [{ role: "ops", model: "fake-model", systemPrompt: "you ship things" }] };
	const teamOptions = { resolveModel: () => fakeModel, streamFn: gateStreamFn, getApiKey: async () => "test-key" };

	test("a posted run pauses on its gate, resumes over HTTP, and traces complete", async () => {
		const running = startServer(config, { port: 0, sessionsRoot, teamOptions });
		const base = `http://localhost:${running.port}`;
		try {
			const started = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tasks: [{ id: "deploy", role: "ops", prompt: "deploy the app" }] }),
			});
			expect(started.status).toBe(202);
			const { runId } = (await started.json()) as { runId: string };

			const pending = await pollPending(base);
			expect(pending).toEqual({
				runId,
				pending: [{ taskId: "deploy", question: "Ship it?", options: ["yes", "no"] }],
			});

			// Only one run at a time.
			const conflict = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tasks: [{ id: "other", role: "ops" }] }),
			});
			expect(conflict.status).toBe(409);

			const resumed = await fetch(`${base}/tasks/deploy/resume`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ option: "yes" }),
			});
			expect(resumed.status).toBe(200);

			const trace = await pollTraceSettled(base);
			expect(trace.status).toBe("complete");
			expect(trace.tasks[0]).toMatchObject({
				taskId: "deploy",
				role: "ops",
				status: "done",
				sessionId: `${runId}-deploy`,
			});
			expect(trace.tasks[0]?.approvals[0]).toMatchObject({ question: "Ship it?", chosenOption: "yes" });

			// The dag settled, so the next run gets validated instead of 409ing.
			const next = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tasks: [{ id: "x", role: "ghost" }] }),
			});
			expect(next.status).toBe(400);
			expect(((await next.json()) as { error: string }).error).toContain('Unknown role "ghost"');
		} finally {
			await running.stop();
		}
	});

	test("a paused run survives a server restart with resumeInterrupted", async () => {
		const restartRoot = mkdtempSync(join(tmpdir(), "hooteams-server-restart-"));
		try {
			const first = startServer(config, { port: 0, sessionsRoot: restartRoot, teamOptions });
			const baseA = `http://localhost:${first.port}`;
			const started = await fetch(`${baseA}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tasks: [{ id: "deploy", role: "ops", prompt: "deploy the app" }] }),
			});
			const { runId } = (await started.json()) as { runId: string };
			await pollPending(baseA);
			// Let the queued session writes (approval_request, dag snapshot) land.
			await new Promise((resolve) => setTimeout(resolve, 100));
			await first.stop();

			const second = startServer(config, { port: 0, sessionsRoot: restartRoot, teamOptions, resumeInterrupted: true });
			const baseB = `http://localhost:${second.port}`;
			try {
				const pending = await pollPending(baseB);
				expect(pending).toEqual({
					runId,
					pending: [{ taskId: "deploy", question: "Ship it?", options: ["yes", "no"] }],
				});

				const resumed = await fetch(`${baseB}/tasks/deploy/resume`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ option: "yes" }),
				});
				expect(resumed.status).toBe(200);

				const trace = await pollTraceSettled(baseB);
				expect(trace.status).toBe("complete");
				expect(trace.runId).toBe(runId);
				expect(trace.tasks[0]).toMatchObject({ taskId: "deploy", status: "done" });
			} finally {
				await second.stop();
			}
		} finally {
			rmSync(restartRoot, { recursive: true, force: true });
		}
	});
});
