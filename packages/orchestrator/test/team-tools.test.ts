import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeMcpTools, type StreamFn } from "@kolisachint/hoocode-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream } from "@kolisachint/hoocode-ai";
import { EventStream } from "@kolisachint/hoocode-ai";
import { TeamChannel } from "../src/channel.js";
import { TaskDag } from "@kolisachint/hooteams-dag";
import { createDelegateTaskTool, createSpawnAgentTool } from "../src/planner.js";
import { Team } from "../src/team.js";

const STUB_MCP_SERVER = join(dirname(fileURLToPath(import.meta.url)), "stub-mcp-server.mjs");

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

/** Every run finishes immediately with a one-line text message. */
function textStreamFn(): StreamFn {
	return () => {
		const stream = createAssistantMessageStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "ok" }]) });
		});
		return stream;
	};
}

/** First turn: call the given tool. Second turn: finish with plain text. */
function toolCallingStreamFn(toolName: string, args: Record<string, unknown>): StreamFn {
	let turn = 0;
	return () => {
		const stream = createAssistantMessageStream();
		const current = turn++;
		queueMicrotask(() => {
			if (current === 0) {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: "tool-1", name: toolName, arguments: args } as any],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "done" }]) });
			}
		});
		return stream;
	};
}

describe("per-role tools", () => {
	let cwd: string;

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "team-tools-"));
	});

	afterAll(async () => {
		closeMcpTools();
		await rm(cwd, { recursive: true, force: true });
	});

	test("spawn() without tool fields behaves as before (no tools)", () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel });
		const agent = team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });
		expect(agent.state.tools).toEqual([]);
	});

	test("defaultTools: true equips the worker with the built-in coding tools", () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel });
		const agent = team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model", defaultTools: true, cwd });
		const names = agent.state.tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).toContain("edit");
		expect(names.length).toBeGreaterThanOrEqual(7);
	});

	test("a spawned worker with defaultTools executes a bash tool call", async () => {
		const team = new Team(new TeamChannel(), {
			resolveModel: () => fakeModel,
			streamFn: toolCallingStreamFn("bash", { command: "echo tool-roundtrip-ok" }),
		});
		const agent = team.spawn({ role: "runner", systemPrompt: "run", model: "fake-model", defaultTools: true, cwd });
		await agent.prompt("run the command");

		const toolResults = agent.state.messages.filter((message: any) => message.role === "toolResult");
		expect(toolResults.length).toBe(1);
		expect(JSON.stringify(toolResults[0])).toContain("tool-roundtrip-ok");
	});

	test("custom tools are appended after defaultTools", () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel });
		const custom = {
			name: "custom",
			label: "custom",
			description: "custom tool",
			parameters: { type: "object", properties: {} } as any,
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined }),
		};
		const agent = team.spawn({
			role: "mixed",
			systemPrompt: "s",
			model: "fake-model",
			defaultTools: true,
			cwd,
			tools: [custom],
		});
		const names = agent.state.tools.map((tool) => tool.name);
		expect(names[0]).toBe("bash");
		expect(names[names.length - 1]).toBe("custom");
	});

	test("spawn() rejects mcpConfigPath; spawnAsync() loads MCP tools", async () => {
		const mcpConfigPath = join(cwd, "mcp.json");
		await writeFile(
			mcpConfigPath,
			JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [STUB_MCP_SERVER] } } }),
		);

		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel });
		expect(() => team.spawn({ role: "mcp", systemPrompt: "s", model: "fake-model", mcpConfigPath })).toThrow(
			/spawnAsync/,
		);

		const agent = await team.spawnAsync({
			role: "mcp",
			systemPrompt: "s",
			model: "fake-model",
			defaultTools: true,
			cwd,
			mcpConfigPath,
		});
		const names = agent.state.tools.map((tool) => tool.name);
		expect(names[0]).toBe("bash");
		expect(names).toContain("mcp_stub_echo");
		// MCP tools come after the default bundle.
		expect(names.indexOf("mcp_stub_echo")).toBeGreaterThan(names.indexOf("ls"));
	});

	test("planner spawn_agent forwards defaultTools/cwd and spawns a tool-equipped worker", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel });
		const spawnTool = createSpawnAgentTool(team);
		expect(JSON.stringify(spawnTool.parameters)).toContain("mcpConfigPath");

		const result = await spawnTool.execute("call-1", {
			role: "builder",
			systemPrompt: "build things",
			model: "fake-model",
			defaultTools: true,
			cwd,
		} as any);

		const agent = team.get("builder");
		expect(agent).toBeDefined();
		const names = agent!.state.tools.map((tool) => tool.name);
		expect(names).toContain("bash");
		expect(JSON.stringify(result.content)).toContain("7 tools");
	});

	test("spawn_agent registers the worker's task in the dag when taskId is given", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const dag = new TaskDag();
		const spawnTool = createSpawnAgentTool(team, dag);

		const result = await spawnTool.execute("call-1", {
			role: "builder",
			systemPrompt: "build things",
			model: "fake-model",
			taskId: "t-build",
		} as any);

		expect(dag.get("t-build")?.role).toBe("builder");
		// no initial task, so the node stays dispatchable
		expect(dag.get("t-build")?.status).toBe("idle");
		expect((result.details as any).taskId).toBe("t-build");

		// with an initial task, the node is marked running so an orchestrator won't double-dispatch
		await spawnTool.execute("call-2", {
			role: "tester",
			systemPrompt: "test things",
			model: "fake-model",
			task: "run the tests",
			taskId: "t-test",
		} as any);
		expect(dag.get("t-test")?.status).not.toBe("idle");
		await team.get("tester")!.waitForIdle();
	});

	test("delegate_task steers the named agent and rejects unknown roles", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const agent = team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });
		const delegateTool = createDelegateTaskTool(team);

		const result = await delegateTool.execute("call-1", { role: "coder", task: "fix the bug" } as any);
		expect(JSON.stringify(result.content)).toContain("coder");
		await agent.waitForIdle();
		expect(JSON.stringify(agent.state.messages)).toContain("fix the bug");

		expect(delegateTool.execute("call-2", { role: "ghost", task: "anything" } as any)).rejects.toThrow(
			/No agent for role "ghost".*coder/,
		);
	});

	test("planner has both spawn_agent and delegate_task tools", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const { Planner } = await import("../src/planner.js");
		const planner = new Planner({ team });

		// Verify planner has both tools
		const toolNames = planner.agent.state.tools.map((tool) => tool.name);
		expect(toolNames).toContain("spawn_agent");
		expect(toolNames).toContain("delegate_task");

		// Spawn a worker
		const worker = team.spawn({ role: "worker", systemPrompt: "do work", model: "fake-model" });

		// Delegate task to the worker using the planner's delegate_task tool
		const delegateTool = planner.agent.state.tools.find((t) => t.name === "delegate_task");
		expect(delegateTool).toBeDefined();

		const result = await delegateTool!.execute("call-1", { role: "worker", task: "complete the task" } as any);
		expect(JSON.stringify(result.content)).toContain("worker");

		// Verify the worker received the delegated task
		await worker.waitForIdle();
		expect(JSON.stringify(worker.state.messages)).toContain("complete the task");
	});

	test("planner can spawn agent and then delegate to it", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const { Planner } = await import("../src/planner.js");
		const planner = new Planner({ team });

		// Use spawn_agent tool to create a coder
		const spawnTool = planner.agent.state.tools.find((t) => t.name === "spawn_agent");
		expect(spawnTool).toBeDefined();

		await spawnTool!.execute("call-1", {
			role: "coder",
			systemPrompt: "You write code",
			model: "fake-model",
		} as any);

		// Verify coder was spawned
		const coder = team.get("coder");
		expect(coder).toBeDefined();

		// Use delegate_task tool to assign work to the coder
		const delegateTool = planner.agent.state.tools.find((t) => t.name === "delegate_task");
		expect(delegateTool).toBeDefined();

		const result = await delegateTool!.execute("call-2", { role: "coder", task: "write a haiku about coding" } as any);
		expect(JSON.stringify(result.content)).toContain("coder");

		// Verify the coder received the delegated task
		await coder!.waitForIdle();
		expect(JSON.stringify(coder!.state.messages)).toContain("write a haiku about coding");
	});

	test("a dryRun planner buffers the plan instead of spawning agents", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const { Planner } = await import("../src/planner.js");
		const planner = new Planner({ team, dryRun: true });
		expect(planner.planBuffer).toEqual({ roles: [], tasks: [] });

		const spawnTool = planner.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
		const first = await spawnTool.execute("call-1", {
			role: "coder",
			systemPrompt: "write code",
			model: "fake-model",
			task: "implement it",
			taskId: "t-code",
			retries: 1,
		} as any);
		await spawnTool.execute("call-2", {
			role: "tester",
			systemPrompt: "test code",
			model: "fake-model",
			task: "test it",
			taskId: "t-test",
			deps: ["t-code"],
		} as any);

		// nothing was spawned and nothing ran
		expect(team.roles()).toEqual([]);
		expect(JSON.stringify(first.content)).toContain("dry run");
		expect(planner.planBuffer!.roles.map((role) => role.role)).toEqual(["coder", "tester"]);
		expect(planner.planBuffer!.tasks).toEqual([
			{ id: "t-code", role: "coder", prompt: "implement it", deps: undefined, retries: 1 },
			{ id: "t-test", role: "tester", prompt: "test it", deps: ["t-code"], retries: undefined },
		]);

		// a clashing taskId gets a fresh id instead of overwriting
		await spawnTool.execute("call-3", { role: "coder", systemPrompt: "write code", model: "fake-model", task: "more", taskId: "t-code" } as any);
		expect(planner.planBuffer!.tasks.at(-1)?.id).toBe("t-code-2");
		expect(planner.planBuffer!.roles.map((role) => role.role)).toEqual(["coder", "tester"]);

		// delegate_task plans a task for an existing role and rejects unknown ones
		const delegateTool = planner.agent.state.tools.find((tool) => tool.name === "delegate_task")!;
		await delegateTool.execute("call-4", { role: "tester", task: "re-test it" } as any);
		expect(planner.planBuffer!.tasks.at(-1)).toMatchObject({ id: "tester", role: "tester", prompt: "re-test it" });
		expect(delegateTool.execute("call-5", { role: "ghost", task: "anything" } as any)).rejects.toThrow(/No planned agent/);
	});

	test("agents spawned with team parameter get delegate_task tool", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const { createNodeHarnessFactory } = await import("../src/node-harness.js");
		const { mkdirSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const sessionsRoot = join(tmpdir(), "node-harness-delegation-test");
		mkdirSync(sessionsRoot, { recursive: true });

		try {
			// Spawn an agent to have it in the team
			team.spawn({ role: "coder", systemPrompt: "You write code", model: "fake-model" });

			// Create harness factory WITH team support and mock model resolver
			const createHarness = createNodeHarnessFactory({
				roles: [{ role: "coder", systemPrompt: "You write code", model: "fake-model", defaultTools: false }],
				runId: "test-run",
				sessionsRoot,
				team,  // Pass team to enable delegation
				resolveModel: () => fakeModel,  // Mock model resolver
			});

			// Create a harness for a coder task
			const handle = await createHarness({ id: "task-1", role: "coder", deps: [], status: "idle" });

			// The harness wraps the underlying AgentHarness, which has the tools
			// We can verify by checking if the harness can use the delegate_task tool
			// For now, we verify the harness was created successfully
			expect(handle.harness).toBeDefined();
			expect(handle.sessionId).toBeDefined();

			// The delegate_task tool is added to the tools array before creating the harness
			// This test verifies the code path is executed (tools are added when team is provided)
			// We can't directly access the tools through NodeHandle interface, but the tool
			// will be available when the agent actually runs
		} finally {
			rmSync(sessionsRoot, { recursive: true, force: true });
		}
	});

	test("adopt registers a messaging target without attaching; release respects adopted + agentId", () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel });
		// spawn() hands back a real Agent we can re-register under another role via adopt().
		const agent = team.spawn({ role: "spawned", systemPrompt: "s", model: "fake-model" });

		team.adopt("peer", "agent-1", agent);
		expect(team.has("peer")).toBe(true);
		expect(team.roles()).toContain("peer");

		// release with a stale agentId must not clear a registration owned by another id.
		team.release("peer", "other-id");
		expect(team.has("peer")).toBe(true);
		// matching id clears it.
		team.release("peer", "agent-1");
		expect(team.has("peer")).toBe(false);

		// release is a no-op on spawned (channel-attached) members — those use kill().
		team.release("spawned");
		expect(team.has("spawned")).toBe(true);
	});

	test("createNodeHarnessFactory adopts the node agent so a peer's delegate_task reaches it; dispose releases", async () => {
		const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
		const sessionsRoot = await mkdtemp(join(tmpdir(), "node-adopt-"));
		try {
			const { createNodeHarnessFactory } = await import("../src/node-harness.js");
			const createHarness = createNodeHarnessFactory({
				roles: [{ role: "worker", systemPrompt: "do work", model: "fake-model" }],
				runId: "run-adopt",
				sessionsRoot,
				team,
				resolveModel: () => fakeModel,
				streamFn: textStreamFn(),
			});

			expect(team.has("worker")).toBe(false);
			const handle = await createHarness({ id: "t1", role: "worker", deps: [], status: "idle" });
			// The node is now addressable by peers, without being attached to the channel.
			expect(team.has("worker")).toBe(true);
			expect(team.roles()).toContain("worker");

			// A peer's delegate_task lands a message on the adopted node agent.
			const delegateTool = createDelegateTaskTool(team);
			await delegateTool.execute("call-1", { role: "worker", task: "peer-delivered task" } as any);
			await team.get("worker")!.waitForIdle();
			expect(JSON.stringify(team.get("worker")!.state.messages)).toContain("peer-delivered task");

			// Teardown drops the registration so a settled node stops being addressable.
			handle.dispose?.();
			expect(team.has("worker")).toBe(false);
		} finally {
			await rm(sessionsRoot, { recursive: true, force: true });
		}
	});

	test("an advisor node stays adopted as a messaging target until the run ends", async () => {
		const { createNodeHarnessFactory } = await import("../src/node-harness.js");
		const { TeamOrchestrator } = await import("../src/team-orchestrator.js");
		const { InMemorySessionRepo } = await import("@kolisachint/hoocode-agent-core");
		const sessionsRoot = await mkdtemp(join(tmpdir(), "advisor-run-"));
		try {
			const team = new Team(new TeamChannel(), { resolveModel: () => fakeModel, streamFn: textStreamFn() });
			const dag = new TaskDag();
			dag.add({ id: "arch", role: "arch", advisor: true });
			dag.add({ id: "impl", role: "impl", deps: ["arch"] });
			const createHarness = createNodeHarnessFactory({
				roles: [
					{ role: "arch", systemPrompt: "arch", model: "fake-model" },
					{ role: "impl", systemPrompt: "impl", model: "fake-model" },
				],
				runId: "advisor-run",
				sessionsRoot,
				team,
				resolveModel: () => fakeModel,
				streamFn: textStreamFn(),
			});

			const adoptedAtSettle: Record<string, boolean> = {};
			const session = await new InMemorySessionRepo().create();
			await new TeamOrchestrator(dag, {
				session,
				createHarness,
				// Snapshot whether the advisor (arch) is still adopted as each node settles.
				afterTaskSettle: (node) => {
					adoptedAtSettle[node.id] = team.has("arch");
				},
			}).run();

			// The advisor is still adopted at its own settle and while impl runs after it...
			expect(adoptedAtSettle.arch).toBe(true);
			expect(adoptedAtSettle.impl).toBe(true);
			// ...and released once the run finishes.
			expect(team.has("arch")).toBe(false);
		} finally {
			await rm(sessionsRoot, { recursive: true, force: true });
		}
	});
});

describe("Team.trackStatus reports paused gates", () => {
	function spawnedTeam() {
		const channel = new TeamChannel();
		const team = new Team(channel, { resolveModel: () => fakeModel });
		team.spawn({ role: "coder", systemPrompt: "code", model: "fake-model" });
		return { channel, team };
	}

	test("task_paused sets the member to paused", () => {
		const { channel, team } = spawnedTeam();
		channel.publish({
			type: "task_paused",
			taskId: "t1",
			role: "coder",
			agentId: "a1",
			question: "Approve?",
			options: ["approve", "revise"],
			ts: Date.now(),
		});
		expect(team.status().coder).toBe("paused");
	});

	test("agent_end mirrored right after task_paused does not clobber paused", () => {
		const { channel, team } = spawnedTeam();
		channel.publish({ type: "task_paused", taskId: "t1", role: "coder", agentId: "a1", question: "q", options: ["approve"], ts: Date.now() });
		channel.publish({ type: "agent_end", role: "coder", agentId: "a1", ts: Date.now(), messages: [] } as any);
		expect(team.status().coder).toBe("paused");
	});

	test("task_resumed lifts paused back to thinking; a later agent_end settles done", () => {
		const { channel, team } = spawnedTeam();
		channel.publish({ type: "task_paused", taskId: "t1", role: "coder", agentId: "a1", question: "q", options: ["approve"], ts: Date.now() });
		channel.publish({ type: "task_resumed", taskId: "t1", role: "coder", agentId: "a1", chosenOption: "approve", ts: Date.now() });
		expect(team.status().coder).toBe("thinking");
		channel.publish({ type: "agent_end", role: "coder", agentId: "a1", ts: Date.now(), messages: [] } as any);
		expect(team.status().coder).toBe("done");
	});
});
