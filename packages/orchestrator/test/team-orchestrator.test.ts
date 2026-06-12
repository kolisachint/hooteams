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
			{ runId: orchestrator.runId, taskId: "deploy", question: "Deploy to prod?", options: ["yes", "no"], ts: expect.any(Number) },
		]);
		const responses = await customEntries(session, "approval_response");
		expect(responses).toEqual([{ runId: orchestrator.runId, taskId: "deploy", chosenOption: "yes\nship it", ts: expect.any(Number) }]);
		const display = (await session.getEntries()).find((entry) => entry.type === "custom_message");
		expect(display).toMatchObject({ display: true });
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

	test("chains dependency outputs into dependent prompts", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		dag.add({ id: "b", role: "writer", deps: ["a"] });
		const { fakes, createHarness } = fixture();

		await new TeamOrchestrator(dag, { session, createHarness }).run();

		expect(dag.get("a")?.output).toBe("did a");
		expect(fakes.get("b")?.prompts[0]).toBe("b\n\nResults from the tasks this one depends on:\n\n### a (coder)\ndid a");
	});

	test("a failing node consumes its retries and then succeeds", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder", retries: 2 });
		let attempts = 0;
		const { createHarness } = fixture((harness) => {
			attempts++;
			if (attempts < 3) {
				harness.failRun(new Error(`boom ${attempts}`));
				return;
			}
			harness.endRun([assistant("recovered")]);
		});
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		await new TeamOrchestrator(dag, { session, channel, createHarness, runId: "run-r" }).run();

		expect(attempts).toBe(3);
		expect(dag.get("a")).toMatchObject({ status: "done", attempts: 2, output: "recovered" });
		const retried = events.filter((event) => event.type === "task_retried");
		expect(retried.map((event: any) => [event.attempt, event.error])).toEqual([
			[1, "boom 1"],
			[2, "boom 2"],
		]);
		expect(events.at(-1)?.type).toBe("dag_complete");
		const entries = await customEntries(session, "task_retry");
		expect(entries.map((data) => data.error)).toEqual(["boom 1", "boom 2"]);
	});

	test("exhausted retries fail the node and escalate via onTaskFailed", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder", retries: 1 });
		let attempts = 0;
		const { createHarness } = fixture((harness) => {
			harness.failRun(new Error(`boom ${++attempts}`));
		});
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));
		const escalations: Array<[string, string]> = [];

		await new TeamOrchestrator(dag, {
			session,
			channel,
			createHarness,
			onTaskFailed: (node, error) => escalations.push([node.id, error]),
		}).run();

		expect(attempts).toBe(2);
		expect(dag.get("a")?.status).toBe("error");
		expect(escalations).toEqual([["a", "boom 2"]]);
		expect(events.at(-1)?.type).toBe("dag_failed");
	});

	test("a GOAL_MET verdict completes the run after one validation pass", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		const { createHarness } = fixture();
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));
		const contexts: string[] = [];

		await new TeamOrchestrator(dag, {
			session,
			channel,
			createHarness,
			validator: {
				goal: "write a haiku",
				validate: async (context) => {
					contexts.push(context);
					return "Looks complete.\nGOAL_MET";
				},
			},
		}).run();

		expect(contexts).toHaveLength(1);
		expect(contexts[0]).toContain("write a haiku");
		expect(contexts[0]).toContain("did a");
		expect(events.at(-1)?.type).toBe("dag_complete");
		expect(await customEntries(session, "validation_result")).toEqual([
			{ runId: expect.any(String), round: 1, met: true, reason: undefined, retryTaskId: undefined, ts: expect.any(Number) },
		]);
	});

	test("a GOAL_UNMET verdict re-runs the named task before the next pass settles the run", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		const { promptOrder, createHarness } = fixture();
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));
		let round = 0;

		await new TeamOrchestrator(dag, {
			session,
			channel,
			createHarness,
			validator: { validate: async () => (++round === 1 ? "GOAL_UNMET: output too short | a" : "GOAL_MET") },
		}).run();

		expect(round).toBe(2);
		expect(promptOrder).toEqual(["a", "a"]);
		expect(dag.get("a")?.status).toBe("done");
		expect(events.some((event) => event.type === "task_retried" && event.error === "goal validation: output too short")).toBe(true);
		expect(events.at(-1)?.type).toBe("dag_complete");
	});

	test("an unmet verdict with no rounds left fails the run", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		const { promptOrder, createHarness } = fixture();
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		await new TeamOrchestrator(dag, {
			session,
			channel,
			createHarness,
			validator: { maxRounds: 1, validate: async () => "GOAL_UNMET: not even close | a" },
		}).run();

		expect(promptOrder).toEqual(["a"]);
		expect(events.some((event) => event.type === "team_error" && event.error.includes("not even close"))).toBe(true);
		expect(events.at(-1)?.type).toBe("dag_failed");
	});

	test("a throwing validator does not block completion", async () => {
		const session = await new InMemorySessionRepo().create();
		const dag = new TaskDag();
		dag.add({ id: "a", role: "coder" });
		const { createHarness } = fixture();
		const channel = new TeamChannel();
		const events: TeamEvent[] = [];
		channel.subscribe((event) => events.push(event));

		await new TeamOrchestrator(dag, {
			session,
			channel,
			createHarness,
			validator: {
				validate: async () => {
					throw new Error("validator down");
				},
			},
		}).run();

		expect(events.some((event) => event.type === "team_error" && event.error.includes("validator down"))).toBe(true);
		expect(events.at(-1)?.type).toBe("dag_complete");
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
