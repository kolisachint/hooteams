#!/usr/bin/env bun
/**
 * Demo stream: starts the hooteams server and publishes scripted TeamEvents
 * so hoocanvas / `hooteams attach` can be developed without real agents or
 * API keys.
 *
 *   bun run scripts/demo.ts [--port 4242]
 */
import type { AgentEvent, Subscribable } from "../packages/orchestrator/src/index.js";
import { startServer } from "../apps/server/src/lib.js";

class ScriptedAgent implements Subscribable {
	private listeners = new Set<(event: AgentEvent) => void | Promise<void>>();

	subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentEvent): void {
		for (const listener of this.listeners) void listener(event);
	}
}

const portFlag = process.argv.indexOf("--port");
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 4242;

const running = startServer({ team: [] }, { port });
console.log(`demo stream on http://localhost:${running.port} — Ctrl+C to stop`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeAgent(role: string): ScriptedAgent {
	const agent = new ScriptedAgent();
	running.channel.attach(role, crypto.randomUUID(), agent);
	return agent;
}

const planner = makeAgent("planner");
const coder = makeAgent("coder");
const tester = makeAgent("tester");

async function streamText(agent: ScriptedAgent, text: string, thinking = false, delay = 35): Promise<void> {
	const kind = thinking ? "thinking" : "text";
	agent.emit({
		type: "message_update",
		message: {} as any,
		assistantMessageEvent: { type: `${kind}_start`, contentIndex: 0, partial: {} } as any,
	});
	for (const word of text.split(/(?<= )/)) {
		agent.emit({
			type: "message_update",
			message: {} as any,
			assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta: word, partial: {} } as any,
		});
		await sleep(delay);
	}
	agent.emit({
		type: "message_update",
		message: {} as any,
		assistantMessageEvent: { type: `${kind}_end`, contentIndex: 0, content: text, partial: {} } as any,
	});
}

async function runTool(agent: ScriptedAgent, name: string, args: unknown, ms: number, fail = false): Promise<void> {
	const toolCallId = crypto.randomUUID();
	agent.emit({ type: "tool_execution_start", toolCallId, toolName: name, args });
	await sleep(ms);
	agent.emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: name,
		result: fail ? { error: "exit code 1" } : { ok: true },
		isError: fail,
	});
}

function endTurn(agent: ScriptedAgent, input: number, output: number): void {
	agent.emit({
		type: "turn_end",
		message: {
			role: "assistant",
			content: [],
			usage: { input, output, cost: { total: (input + output) / 250000 } },
		} as any,
		toolResults: [],
	});
}

async function plannerScript(): Promise<void> {
	planner.emit({ type: "agent_start" });
	await streamText(planner, "Breaking the goal into tasks: auth module refactor, then token refresh. ", true, 50);
	await streamText(planner, "I'll hand the auth refactor to the coder and let the tester verify after.");
	await runTool(planner, "spawn_agent", { role: "coder" }, 700);
	endTurn(planner, 1240, 186);
	planner.emit({ type: "agent_end", messages: [] });
}

async function coderScript(): Promise<void> {
	await sleep(1800);
	coder.emit({ type: "agent_start" });
	await streamText(coder, "Reading the auth module to map the refresh flow. ", true, 45);
	await runTool(coder, "read_file", { path: "src/auth.ts" }, 900);
	await streamText(coder, "The token refresh races the logout path — extracting a single refresh queue.");
	await runTool(coder, "write_file", { path: "src/auth.ts" }, 1600);
	endTurn(coder, 3420, 512);
	coder.emit({ type: "agent_end", messages: [] });
}

async function testerScript(): Promise<void> {
	await sleep(4200);
	tester.emit({ type: "agent_start" });
	await streamText(tester, "Running the auth suite against the refactor.");
	await runTool(tester, "run_tests", { suite: "auth" }, 2200, true);
	await streamText(tester, "Two failures in token expiry edge cases — reporting back to the coder.");
	endTurn(tester, 980, 144);
	tester.emit({ type: "agent_end", messages: [] });
}

// Loop the whole scene forever so there's always something live to watch.
while (true) {
	await Promise.all([plannerScript(), coderScript(), testerScript()]);
	await sleep(2500);
}
