import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeMcpTools, type StreamFn } from "@kolisachint/hoocode-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@kolisachint/hoocode-ai";
import { TeamChannel } from "../src/channel.js";
import { createSpawnAgentTool } from "../src/planner.js";
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

/** First turn: call the given tool. Second turn: finish with plain text. */
function toolCallingStreamFn(toolName: string, args: Record<string, unknown>): StreamFn {
	let turn = 0;
	return () => {
		const stream = new MockAssistantStream();
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
});
