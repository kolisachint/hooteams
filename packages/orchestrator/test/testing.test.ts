import { describe, expect, test } from "bun:test";
import { InMemorySessionRepo } from "@kolisachint/hoocode-agent-core";
import { TaskDag } from "../src/dag.js";
import { TeamOrchestrator } from "../src/team-orchestrator.js";
import { FakeNodeHarness, fakeHarnessFactory } from "../src/testing.js";
import type { AgentEvent } from "../src/types.js";

describe("FakeNodeHarness", () => {
	test("emits a settled run and records the prompt", async () => {
		const harness = new FakeNodeHarness().queue("hello");
		const events: AgentEvent[] = [];
		harness.subscribe((event) => {
			events.push(event);
		});

		await harness.prompt("go");

		expect(harness.prompts).toEqual(["go"]);
		expect(events.map((event) => event.type)).toEqual(["message_end", "agent_end"]);
	});

	test("rejects with a queued error", async () => {
		const harness = new FakeNodeHarness().queue(new Error("nope"));
		await expect(harness.prompt("go")).rejects.toThrow("nope");
	});

	test("echoes the prompt when nothing is queued", async () => {
		const harness = new FakeNodeHarness();
		const ends: AgentEvent[] = [];
		harness.subscribe((event) => {
			if (event.type === "agent_end") ends.push(event);
		});

		await harness.prompt("build");

		const message = (ends[0] as Extract<AgentEvent, { type: "agent_end" }>).messages[0] as any;
		expect(message.content[0].text).toBe("did build");
	});

	test("records steering messages", () => {
		const harness = new FakeNodeHarness();
		harness.steer("left");
		harness.steer("right");
		expect(harness.steers).toEqual(["left", "right"]);
	});
});

describe("fakeHarnessFactory", () => {
	test("drives a full dag run deterministically with no real model", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		dag.add({ id: "b", role: "writer", deps: ["a"] });
		const harnesses = new Map<string, FakeNodeHarness>();
		const createHarness = fakeHarnessFactory((node, harness) => {
			harness.queue(`output of ${node.id}`);
			harnesses.set(node.id, harness);
		});

		await new TeamOrchestrator(dag, { session, createHarness }).run();

		expect(dag.get("a")?.output).toBe("output of a");
		expect(dag.get("b")?.status).toBe("done");
		// b's prompt chained a's output through the dependency edge
		expect(harnesses.get("b")?.prompts[0]).toContain("output of a");
	});

	test("a queued error settles the node as failed", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		const createHarness = fakeHarnessFactory((_node, harness) => {
			harness.queue(new Error("boom"));
		});

		await new TeamOrchestrator(dag, { session, createHarness }).run();

		expect(dag.get("a")?.status).toBe("error");
	});
});
