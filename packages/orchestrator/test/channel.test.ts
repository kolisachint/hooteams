import { describe, expect, test } from "bun:test";
import { REPLAY_BUFFER_SIZE, type Subscribable, TeamChannel } from "../src/channel.js";
import type { AgentEvent, TeamEvent } from "../src/types.js";

/** Stand-in for Agent: stores listeners and lets the test fire events. */
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

const startEvent: AgentEvent = { type: "agent_start" };
const endEvent: AgentEvent = { type: "agent_end", messages: [] };

describe("event tagging", () => {
	test("tags agent events with role, agentId, and timestamp", () => {
		const channel = new TeamChannel();
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);

		const received: TeamEvent[] = [];
		channel.subscribe((event) => received.push(event));
		const before = Date.now();
		agent.emit(startEvent);

		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ type: "agent_start", role: "coder", agentId: "id-1" });
		expect(received[0]!.ts).toBeGreaterThanOrEqual(before);
	});

	test("role-filtered subscription only sees that role", () => {
		const channel = new TeamChannel();
		const coder = new FakeAgent();
		const tester = new FakeAgent();
		channel.attach("coder", "id-1", coder);
		channel.attach("tester", "id-2", tester);

		const received: TeamEvent[] = [];
		channel.subscribe((event) => received.push(event), "tester");
		coder.emit(startEvent);
		tester.emit(startEvent);

		expect(received.map((event) => event.role)).toEqual(["tester"]);
	});

	test("rejects a second agent on the same role", () => {
		const channel = new TeamChannel();
		channel.attach("coder", "id-1", new FakeAgent());
		expect(() => channel.attach("coder", "id-2", new FakeAgent())).toThrow(/already has an agent/);
	});

	test("detach stops mirroring and unsubscribe stops delivery", () => {
		const channel = new TeamChannel();
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);

		const received: TeamEvent[] = [];
		const unsubscribe = channel.subscribe((event) => received.push(event));
		agent.emit(startEvent);
		unsubscribe();
		agent.emit(endEvent);
		expect(received).toHaveLength(1);

		channel.detach("coder");
		const after: TeamEvent[] = [];
		channel.subscribe((event) => after.push(event));
		agent.emit(startEvent);
		expect(after).toHaveLength(0);
		expect(channel.roles()).toEqual([]);
	});
});

describe("replay buffer", () => {
	test("replays buffered events to a late subscriber", () => {
		const channel = new TeamChannel();
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);

		agent.emit(startEvent);
		agent.emit(endEvent);

		const replay = channel.replay("coder");
		expect(replay.map((event) => event.type)).toEqual(["agent_start", "agent_end"]);
	});

	test("keeps only the last REPLAY_BUFFER_SIZE events per agent", () => {
		const channel = new TeamChannel();
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);

		for (let i = 0; i < REPLAY_BUFFER_SIZE + 25; i++) {
			agent.emit({ type: "tool_execution_start", toolCallId: `call-${i}`, toolName: "noop", args: {} });
		}

		const replay = channel.replay("coder");
		expect(replay).toHaveLength(REPLAY_BUFFER_SIZE);
		const first = replay[0] as TeamEvent & { toolCallId: string };
		expect(first.toolCallId).toBe("call-25");
	});

	test("replay without a role merges all agents in timestamp order", () => {
		const channel = new TeamChannel();
		const coder = new FakeAgent();
		const tester = new FakeAgent();
		channel.attach("coder", "id-1", coder);
		channel.attach("tester", "id-2", tester);

		coder.emit(startEvent);
		tester.emit(startEvent);
		coder.emit(endEvent);

		const replay = channel.replay();
		expect(replay).toHaveLength(3);
		const stamps = replay.map((event) => event.ts);
		expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
	});

	test("respects a replay limit", () => {
		const channel = new TeamChannel();
		const agent = new FakeAgent();
		channel.attach("coder", "id-1", agent);
		for (let i = 0; i < 10; i++) agent.emit(startEvent);
		expect(channel.replay("coder", 3)).toHaveLength(3);
	});

	test("replay for unknown role is empty", () => {
		expect(new TeamChannel().replay("ghost")).toEqual([]);
	});
});
