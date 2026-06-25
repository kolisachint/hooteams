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
	type RoleConfig,
	TaskDag,
	type TaskNode,
	TeamMemory,
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
		// HITL is the default: allowAutonomous is false unless explicitly opted in.
		expect(config.allowAutonomous).toBe(false);
	});

	test("allowAutonomous defaults to false and is opt-in via the config file", () => {
		const base = { team: [{ role: "coder", model: "m", systemPrompt: "s" }] };
		expect(validateConfig(base, "test").allowAutonomous).toBe(false);
		expect(validateConfig({ ...base, allowAutonomous: true }, "test").allowAutonomous).toBe(true);
		// Only an explicit boolean true enables it; anything else stays HITL.
		expect(validateConfig({ ...base, allowAutonomous: "yes" as any }, "test").allowAutonomous).toBe(false);
	});

	test("rejects missing team array and malformed entries", () => {
		expect(() => validateConfig({}, "test")).toThrow(/"team" must be an array/);
		expect(() => validateConfig({ team: [{ role: "x" } as any] }, "test")).toThrow(/needs a string "systemPrompt" or "systemPromptFile"/);
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

	test("resolves a static role's model tier through modelCategories", () => {
		const config = validateConfig(
			{ team: [{ role: "coder", systemPrompt: "code", model: "capable", provider: "github-copilot" }] },
			"test",
			{ capable: "claude-opus-4.8" },
		);
		expect(config.team[0]).toMatchObject({ model: "claude-opus-4.8", provider: "github-copilot" });
	});

	test("an unconfigured static-role tier falls back to defaults.model", () => {
		const config = validateConfig(
			{ defaults: { model: "claude-sonnet-4.5", provider: "github-copilot" }, team: [{ role: "coder", systemPrompt: "code", model: "capable" }] },
			"test",
			{ fast: "claude-haiku-4.5" },
		);
		expect(config.team[0]).toMatchObject({ model: "claude-sonnet-4.5", provider: "github-copilot" });
	});

	test("rejects an unconfigured static-role tier with no defaults.model", () => {
		expect(() =>
			validateConfig({ team: [{ role: "coder", systemPrompt: "code", model: "capable" }] }, "test", {}),
		).toThrow(/uses model tier "capable", which is not configured/);
	});
});

describe("startServer", () => {
	test("spawns the configured team and serves status until /stop", async () => {
		const running = startServer(
			{ team: [{ role: "coder", model: "fake-model", systemPrompt: "code" }] },
			{ port: 0, logRuns: false, teamOptions: { resolveModel: () => fakeModel } },
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
			{ port: 0, logRuns: false, teamOptions: { resolveModel: () => fakeModel } },
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
	const memoryRoot = mkdtempSync(join(tmpdir(), "hooteams-server-memory-"));
	afterAll(() => {
		rmSync(sessionsRoot, { recursive: true, force: true });
		rmSync(memoryRoot, { recursive: true, force: true });
	});
	const config = { team: [{ role: "ops", model: "fake-model", systemPrompt: "you ship things" }] };
	const teamOptions = { resolveModel: () => fakeModel, streamFn: gateStreamFn, getApiKey: async () => "test-key" };

	test("a posted run pauses on its gate, resumes over HTTP, and traces complete", async () => {
		// This suite exercises the agent-driven marker gate; opt out of the HITL
		// completion gate so the run settles without an extra approval.
		const running = startServer(config, { port: 0, logRuns: false, sessionsRoot, memoryRoot, teamOptions, allowAutonomous: true });
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

	test("per-run roles and goal validation flow through POST /runs", async () => {
		// Workers reply with work; the goal validator (recognizable by its
		// verdict question) approves.
		const validatingStreamFn: StreamFn = ((_model: any, context: any) => {
			const last = context.messages[context.messages.length - 1] as { content?: Array<{ type: string; text?: string }> };
			const text = (last?.content ?? [])
				.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
				.join("\n");
			const reply = text.includes("Did the team actually achieve the goal?") ? "GOAL_MET" : "a fine haiku";
			const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
			queueMicrotask(() => {
				(stream as any).push({ type: "done", reason: "stop", message: assistantReply(reply) });
			});
			return stream;
		}) as StreamFn;

		const running = startServer(
			{ ...config, validator: "You judge whether the team's haiku satisfies the goal." },
			{ port: 0, logRuns: false, sessionsRoot, memoryRoot, allowAutonomous: true, teamOptions: { ...teamOptions, streamFn: validatingStreamFn } },
		);
		const base = `http://localhost:${running.port}`;
		try {
			const started = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					goal: "write a haiku about shipping",
					roles: [{ role: "poet", systemPrompt: "you write haikus", model: "fake-model" }],
					tasks: [{ id: "draft", role: "poet", prompt: "write the haiku", retries: 1 }],
				}),
			});
			expect(started.status).toBe(202);

			const trace = await pollTraceSettled(base);
			expect(trace.status).toBe("complete");
			// the per-run "poet" role (not in the configured team) ran the task
			expect(trace.tasks[0]).toMatchObject({ taskId: "draft", role: "poet", status: "done" });
			expect(trace.dag?.draft).toMatchObject({ output: "a fine haiku", retries: 1 });
		} finally {
			await running.stop();
		}
	});

	test("a per-run role without its own provider inherits config.defaults.provider (R2-1)", async () => {
		// A planner-produced role often omits provider; the server must backfill it
		// from defaults instead of falling back to anthropic and failing to resolve.
		const seen: RoleConfig[] = [];
		const capturingResolve = (cfg: RoleConfig) => {
			seen.push(cfg);
			return fakeModel;
		};
		// A plain completing stream (no approval marker) so the run settles instead
		// of pausing on the gate — we only care that the role's provider was backfilled.
		const plainStreamFn: StreamFn = (() => {
			const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
			queueMicrotask(() => (stream as any).push({ type: "done", reason: "stop", message: assistantReply("a fine haiku") }));
			return stream;
		}) as StreamFn;
		const running = startServer(
			{ ...config, defaults: { provider: "github-copilot", model: "fake-model" } },
			{ port: 0, logRuns: false, sessionsRoot, memoryRoot, allowAutonomous: true, teamOptions: { ...teamOptions, resolveModel: capturingResolve, streamFn: plainStreamFn } },
		);
		const base = `http://localhost:${running.port}`;
		try {
			const started = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					roles: [{ role: "poet", systemPrompt: "you write haikus", model: "fake-model" }],
					tasks: [{ id: "draft", role: "poet", prompt: "write the haiku" }],
				}),
			});
			expect(started.status).toBe(202);
			const trace = await pollTraceSettled(base);
			expect(trace.tasks[0]).toMatchObject({ taskId: "draft", role: "poet" });
			const poet = seen.find((cfg) => cfg.role === "poet");
			expect(poet?.provider).toBe("github-copilot");
		} finally {
			await running.stop();
		}
	});

	test("a per-run role with a guessed model but no provider takes the default model, not the guess", async () => {
		// The planner often guesses a model id in anthropic's dash spelling while
		// omitting the provider. Pinning that id onto the inherited github-copilot
		// provider (which spells it with a dot) would miss getModel() and die on
		// dispatch, so provider and model are inherited together as a pair.
		const seen: RoleConfig[] = [];
		const capturingResolve = (cfg: RoleConfig) => {
			seen.push(cfg);
			return fakeModel;
		};
		const plainStreamFn: StreamFn = (() => {
			const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
			queueMicrotask(() => (stream as any).push({ type: "done", reason: "stop", message: assistantReply("a fine haiku") }));
			return stream;
		}) as StreamFn;
		const running = startServer(
			{ ...config, defaults: { provider: "github-copilot", model: "fake-model" } },
			{ port: 0, logRuns: false, sessionsRoot, memoryRoot, allowAutonomous: true, teamOptions: { ...teamOptions, resolveModel: capturingResolve, streamFn: plainStreamFn } },
		);
		const base = `http://localhost:${running.port}`;
		try {
			const started = await fetch(`${base}/runs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					roles: [{ role: "poet", systemPrompt: "you write haikus", model: "claude-sonnet-4-5" }],
					tasks: [{ id: "draft", role: "poet", prompt: "write the haiku" }],
				}),
			});
			expect(started.status).toBe(202);
			await pollTraceSettled(base);
			const poet = seen.find((cfg) => cfg.role === "poet");
			expect(poet?.provider).toBe("github-copilot");
			expect(poet?.model).toBe("fake-model");
		} finally {
			await running.stop();
		}
	});

	test("a paused run survives a server restart with resumeInterrupted", async () => {
		const restartRoot = mkdtempSync(join(tmpdir(), "hooteams-server-restart-"));
		try {
			const first = startServer(config, { port: 0, logRuns: false, sessionsRoot: restartRoot, memoryRoot, teamOptions, allowAutonomous: true });
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

			const second = startServer(config, {
				port: 0,
				logRuns: false,
				sessionsRoot: restartRoot,
				memoryRoot,
				teamOptions,
				resumeInterrupted: true,
				allowAutonomous: true,
			});
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

	test("task outputs are recorded to shared memory and bootstrap the next run", async () => {
		// Replies reveal whether the task prompt carried prior-run memory.
		const memoryAwareStreamFn: StreamFn = ((_model: any, context: any) => {
			const last = context.messages[context.messages.length - 1] as { content?: Array<{ type: string; text?: string }> };
			const text = (last?.content ?? [])
				.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
				.join("\n");
			const reply = text.includes("Shared team memory") ? "bootstrapped from memory" : "learned something new";
			const stream = new MockAssistantStream() as unknown as AssistantMessageEventStream;
			queueMicrotask(() => {
				(stream as any).push({ type: "done", reason: "stop", message: assistantReply(reply) });
			});
			return stream;
		}) as StreamFn;

		const freshMemoryRoot = mkdtempSync(join(tmpdir(), "hooteams-server-memflow-"));
		const running = startServer(
			{ ...config, project: "memflow" },
			{ port: 0, logRuns: false, sessionsRoot, memoryRoot: freshMemoryRoot, allowAutonomous: true, teamOptions: { ...teamOptions, streamFn: memoryAwareStreamFn } },
		);
		const base = `http://localhost:${running.port}`;
		try {
			const postRun = (id: string) =>
				fetch(`${base}/runs`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ tasks: [{ id, role: "ops", prompt: `do ${id}` }] }),
				});

			expect((await postRun("learn")).status).toBe(202);
			const first = await pollTraceSettled(base);
			expect(first.dag?.learn?.output).toBe("learned something new");

			// The first run's output was auto-recorded into the project store.
			const memory = new TeamMemory({ memoryRoot: freshMemoryRoot, project: "memflow" });
			const entries = await memory.list();
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ value: "learned something new", tags: ["ops", "done"] });

			// A second run on the same project bootstraps from it.
			expect((await postRun("apply")).status).toBe(202);
			const second = await pollTraceSettled(base);
			expect(second.dag?.apply?.output).toBe("bootstrapped from memory");
		} finally {
			await running.stop();
			rmSync(freshMemoryRoot, { recursive: true, force: true });
		}
	});
});
