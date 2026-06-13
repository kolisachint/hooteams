import { describe, expect, test } from "bun:test";
import { InMemorySessionRepo, type Session } from "@kolisachint/hoocode-agent-core";
import { TeamChannel } from "../src/channel.js";
import { TaskDag } from "../src/dag.js";
import { TeamOrchestrator } from "../src/team-orchestrator.js";
import type { AgentEvent, AgentMessage, TaskNode, TeamEvent } from "../src/types.js";

function assistant(text: string, errorMessage?: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], errorMessage, timestamp: Date.now() } as unknown as AgentMessage;
}

type Listener = (event: AgentEvent) => Promise<void> | void;
type Script = (harness: FakeHarness, text: string, call: number) => void | Promise<void>;

/**
 * Stands in for AgentHarness: prompt() starts a "run" that the script (or the
 * test, via endRun) finishes; steer() throws while idle, exactly like the
 * real harness.
 */
class FakeHarness {
	prompts: string[] = [];
	steers: string[] = [];
	idle = true;
	private listeners = new Set<Listener>();
	private finish?: { resolve: (value: unknown) => void; reject: (err: unknown) => void };

	constructor(private readonly script?: Script) {}

	prompt(text: string): Promise<unknown> {
		const call = this.prompts.length;
		this.prompts.push(text);
		this.idle = false;
		return new Promise((resolve, reject) => {
			this.finish = { resolve, reject };
			queueMicrotask(() => void this.script?.(this, text, call));
		});
	}

	steer(text: string): void {
		if (this.idle) throw new Error("Cannot steer while idle");
		this.steers.push(text);
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentEvent): void {
		for (const listener of this.listeners) void listener(event);
	}

	say(text: string): void {
		this.emit({ type: "message_end", message: assistant(text) });
	}

	endRun(messages: AgentMessage[]): void {
		this.emit({ type: "agent_end", messages });
		this.idle = true;
		this.finish?.resolve(undefined);
	}

	failRun(err: Error): void {
		this.idle = true;
		this.finish?.reject(err);
	}
}

/** Resolve with the first channel event of the given type. */
function once<T extends TeamEvent["type"]>(channel: TeamChannel, type: T): Promise<Extract<TeamEvent, { type: T }>> {
	return new Promise((resolve) => {
		const unsubscribe = channel.subscribe((event) => {
			if (event.type === type) {
				unsubscribe();
				resolve(event as Extract<TeamEvent, { type: T }>);
			}
		});
	});
}

async function customEntries(session: Session, customType: string): Promise<any[]> {
	const entries = await session.getEntries();
	return entries.filter((entry) => entry.type === "custom" && entry.customType === customType).map((entry: any) => entry.data);
}

const sayAndFinish: Script = (harness, text) => {
	harness.say(`did ${text}`);
	harness.endRun([assistant(`did ${text}`)]);
};

function fixture(script: Script = sayAndFinish) {
	const fakes = new Map<string, FakeHarness>();
	let liveRuns = 0;
	let maxLiveRuns = 0;
	const promptOrder: string[] = [];
	const createHarness = (node: TaskNode) => {
		const fake = new FakeHarness(async (harness, text, call) => {
			promptOrder.push(node.id);
			liveRuns++;
			maxLiveRuns = Math.max(maxLiveRuns, liveRuns);
			await script(harness, text, call);
			liveRuns--;
		});
		fakes.set(node.id, fake);
		return { harness: fake, sessionId: `session-${node.id}` };
	};
	return { fakes, promptOrder, maxLiveRuns: () => maxLiveRuns, createHarness };
}

describe("TeamOrchestrator", () => {
	test("runs the dag in dependency order within maxConcurrent", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		dag.add({ id: "b", role: "coder" });
		dag.add({ id: "c", role: "tester", deps: ["a", "b"] });
		const { promptOrder, maxLiveRuns, createHarness } = fixture();
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness, maxConcurrent: 1, runId: "run-1" });
		await orchestrator.run();

		expect(promptOrder).toEqual(["a", "b", "c"]);
		expect(maxLiveRuns()).toBe(1);
		expect(dag.isComplete()).toBe(true);
		expect(dag.all().every((node) => node.status === "done")).toBe(true);
		expect(events.filter((event) => event.type === "task_started")).toHaveLength(3);
		expect(events.filter((event) => event.type === "task_finished")).toHaveLength(3);
		expect(events.at(-1)?.type).toBe("dag_complete");

		const starts = await customEntries(session, "task_start");
		expect(starts.map((data) => data.sessionId)).toEqual(["session-a", "session-b", "session-c"]);
		const runEnd = await customEntries(session, "run_end");
		expect(runEnd).toEqual([{ runId: "run-1", status: "complete", ts: expect.any(Number) }]);
	});

	test("a failed node blocks dependents and settles the run as failed", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		dag.add({ id: "b", role: "tester", deps: ["a"] });
		const { createHarness } = fixture((harness) => {
			harness.failRun(new Error("boom"));
		});
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		await new TeamOrchestrator(dag, { session, channel, createHarness }).run();

		expect(dag.get("a")?.status).toBe("error");
		expect(dag.get("b")?.status).toBe("idle");
		expect(events.at(-1)?.type).toBe("dag_failed");
		expect(events.some((event) => event.type === "team_error" && event.error === "boom")).toBe(true);
		const ends = await customEntries(session, "task_end");
		expect(ends).toEqual([{ runId: expect.any(String), taskId: "a", status: "error", error: "boom", ts: expect.any(Number) }]);
	});

	test("an assistant errorMessage in the final message fails the node", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		const { createHarness } = fixture((harness) => {
			harness.endRun([assistant("oops", "rate limited")]);
		});

		await new TeamOrchestrator(dag, { session, createHarness }).run();

		expect(dag.get("a")?.status).toBe("error");
	});

	test("pauses on the approval marker, frees the slot, and resumes with a fresh prompt after the run ended", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "deploy", role: "ops" });
		dag.add({ id: "docs", role: "writer" });
		const { fakes, createHarness } = fixture((harness, text, call) => {
			if (harness === fakes.get("deploy") && call === 0) {
				const marker = "AWAITING_APPROVAL: Deploy to prod? | yes, no";
				harness.say(marker);
				harness.endRun([assistant(marker)]);
				return;
			}
			harness.endRun([assistant(`did ${text}`)]);
		});
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));
		const paused = once(channel, "task_paused");

		const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness, maxConcurrent: 1 });
		const run = orchestrator.run();

		const gate = await paused;
		expect(gate).toMatchObject({ taskId: "deploy", role: "ops", question: "Deploy to prod?", options: ["yes", "no"] });
		expect(dag.get("deploy")?.status).toBe("paused");
		expect(orchestrator.pendingApprovals().map((request) => request.taskId)).toEqual(["deploy"]);
		// the paused node released its only slot, so docs ran meanwhile
		await once(channel, "task_finished");
		expect(dag.get("docs")?.status).toBe("done");

		expect(orchestrator.resume("deploy", "yes", "ship it")).toBe(true);
		expect(orchestrator.resume("deploy", "no")).toBe(false);
		await run;

		// the run had ended on the marker, so the answer starts a new prompt
		expect(fakes.get("deploy")?.prompts).toEqual(["deploy", "yes\nship it"]);
		expect(fakes.get("deploy")?.steers).toEqual([]);
		expect(dag.get("deploy")?.status).toBe("done");
		expect(events.some((event) => event.type === "task_resumed" && event.chosenOption === "yes\nship it")).toBe(true);

		const requests = await customEntries(session, "approval_request");
		expect(requests).toEqual([
			{
				runId: orchestrator.runId,
				taskId: "deploy",
				question: "Deploy to prod?",
				options: ["yes", "no"],
				kind: "marker",
				ts: expect.any(Number),
			},
		]);
		const responses = await customEntries(session, "approval_response");
		expect(responses).toEqual([{ runId: orchestrator.runId, taskId: "deploy", chosenOption: "yes\nship it", ts: expect.any(Number) }]);
		const display = (await session.getEntries()).find((entry) => entry.type === "custom_message");
		expect(display).toMatchObject({ display: true });
	});

	test("HITL completion gate: pauses before settling done; approve settles without re-prompting", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "build", role: "coder" });
		const { fakes, createHarness } = fixture(); // sayAndFinish: a clean run end
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));
		const paused = once(channel, "task_paused");

		const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness, allowAutonomous: false });
		const run = orchestrator.run();

		const gate = await paused;
		expect(gate).toMatchObject({ taskId: "build", role: "coder", options: ["approve", "revise"] });
		expect(dag.get("build")?.status).toBe("paused");

		expect(orchestrator.resume("build", "approve")).toBe(true);
		await run;

		expect(dag.get("build")?.status).toBe("done");
		// approve must not re-prompt: the agent ran exactly once.
		expect(fakes.get("build")?.prompts).toEqual(["build"]);
		expect(events.at(-1)?.type).toBe("dag_complete");
		const requests = await customEntries(session, "approval_request");
		expect(requests[0]).toMatchObject({ taskId: "build", kind: "completion", options: ["approve", "revise"] });
	});

	test("HITL completion gate: revise re-prompts with feedback, then approve settles", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "build", role: "coder" });
		const { fakes, createHarness } = fixture(); // each run ends cleanly -> a gate re-opens
		const channel = new TeamChannel();

		const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness, allowAutonomous: false });
		const firstGate = once(channel, "task_paused");
		const run = orchestrator.run();
		await firstGate;

		// revise + feedback re-prompts the agent and re-opens the gate when it settles.
		const secondGate = once(channel, "task_paused");
		expect(orchestrator.resume("build", "revise", "add error handling")).toBe(true);
		await secondGate;

		expect(orchestrator.resume("build", "approve")).toBe(true);
		await run;

		expect(dag.get("build")?.status).toBe("done");
		// the run had ended, so revise starts a fresh prompt carrying just the feedback.
		expect(fakes.get("build")?.prompts).toEqual(["build", "add error handling"]);
	});

	test("steers the live run when the marker arrived mid-run", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "deploy", role: "ops" });
		const { fakes, createHarness } = fixture((harness) => {
			// emit the marker but keep the run open: the agent is still working
			harness.say("AWAITING_APPROVAL: Continue? | go, stop");
		});
		const channel = new TeamChannel();
		const paused = once(channel, "task_paused");

		const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness });
		const run = orchestrator.run();
		await paused;

		expect(orchestrator.resume("deploy", "go")).toBe(true);
		await once(channel, "task_resumed");
		const fake = fakes.get("deploy")!;
		expect(fake.steers).toEqual(["go"]);
		expect(fake.prompts).toEqual(["deploy"]);

		fake.endRun([assistant("continued")]);
		await run;
		expect(dag.get("deploy")?.status).toBe("done");
	});

	test("restores a crashed run from the session and re-surfaces pending approvals", async () => {
		const session = await new InMemorySessionRepo().create();
		// Hand-crafted crash state: a done, b paused on an unanswered gate,
		// c was streaming when the process died, d depends on c.
		const crashed = new TaskDag();
		crashed.add({ id: "a", role: "coder" });
		crashed.add({ id: "b", role: "ops", deps: ["a"] });
		crashed.add({ id: "c", role: "coder", deps: ["a"] });
		crashed.add({ id: "d", role: "tester", deps: ["c"] });
		crashed.markDone("a");
		crashed.markPaused("b");
		crashed.markRunning("c", "streaming");
		await session.appendCustomEntry("run_start", { runId: "run-9", ts: 1 });
		await session.appendCustomEntry("dag_state", { runId: "run-9", dag: crashed.toJSON(), ts: 2 });
		await session.appendCustomEntry("approval_request", { runId: "run-9", taskId: "b", question: "Deploy?", options: ["yes", "no"], ts: 3 });

		const { fakes, promptOrder, createHarness } = fixture();
		const channel = new TeamChannel();
		const paused = once(channel, "task_paused");

		const orchestrator = await TeamOrchestrator.restoreFromSession(session, { channel, createHarness });
		expect(orchestrator.runId).toBe("run-9");
		const run = orchestrator.run();

		const gate = await paused;
		expect(gate).toMatchObject({ taskId: "b", question: "Deploy?", options: ["yes", "no"] });
		expect(orchestrator.resume("b", "yes")).toBe(true);
		await run;

		// b had no live harness: the factory was called fresh and prompted with the answer
		expect(fakes.get("b")?.prompts).toEqual(["yes"]);
		// c was reset from "streaming" to idle and re-dispatched; a was not re-run
		expect(promptOrder.filter((id) => id === "c")).toHaveLength(1);
		expect(promptOrder).not.toContain("a");
		expect(crashedStatuses(orchestrator)).toEqual({ a: "done", b: "done", c: "done", d: "done" });

		function crashedStatuses(restored: TeamOrchestrator): Record<string, string> {
			const result: Record<string, string> = {};
			for (const node of (restored as any).dag.all() as TaskNode[]) {
				result[node.id] = node.status;
			}
			return result;
		}
	});

	test("buildTrace folds session entries into a run trace", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "deploy", role: "ops" });
		dag.add({ id: "verify", role: "tester", deps: ["deploy"] });
		const { createHarness, fakes } = fixture((harness, text, call) => {
			if (harness === fakes.get("deploy") && call === 0) {
				const marker = "AWAITING_APPROVAL: Ship it? | yes, no";
				harness.say(marker);
				harness.endRun([assistant(marker)]);
				return;
			}
			harness.endRun([assistant(`did ${text}`)]);
		});
		const channel = new TeamChannel();
		const paused = once(channel, "task_paused");
		const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness, runId: "run-7" });
		const run = orchestrator.run();
		await paused;
		orchestrator.resume("deploy", "yes");
		await run;

		const trace = await TeamOrchestrator.buildTrace(session, "run-7");
		expect(trace.runId).toBe("run-7");
		expect(trace.status).toBe("complete");
		expect(trace.startedAt).toBeNumber();
		expect(trace.endedAt).toBeNumber();
		expect(trace.dag?.deploy?.status).toBe("done");
		const deploy = trace.tasks.find((task) => task.taskId === "deploy")!;
		expect(deploy).toMatchObject({ role: "ops", status: "done", sessionId: "session-deploy" });
		expect(deploy.startedAt).toBeNumber();
		expect(deploy.endedAt).toBeNumber();
		expect(deploy.approvals).toEqual([
			{ question: "Ship it?", options: ["yes", "no"], chosenOption: "yes", requestedAt: expect.any(Number), resolvedAt: expect.any(Number) },
		]);
		const verify = trace.tasks.find((task) => task.taskId === "verify")!;
		expect(verify.approvals).toEqual([]);
	});

	test("run() may only be called once", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		const { createHarness } = fixture();
		const orchestrator = new TeamOrchestrator(dag, { session, createHarness });
		await orchestrator.run();
		expect(() => orchestrator.run()).toThrow(/once/);
	});
});
