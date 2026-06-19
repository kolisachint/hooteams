import { afterAll, describe, expect, test } from "bun:test";
import { InMemorySessionRepo } from "@kolisachint/hoocode-agent-core";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskDag } from "@kolisachint/hooteams-dag";
import { createBoardTools, createMemoryReadTool, createMemoryWriteTool, projectKeyFromCwd, TeamMemory } from "../src/memory.js";
import { TeamOrchestrator } from "../src/team-orchestrator.js";
import type { AgentEvent, AgentMessage, TaskNode } from "../src/types.js";

const memoryRoot = mkdtempSync(join(tmpdir(), "hooteams-memory-"));
afterAll(() => rmSync(memoryRoot, { recursive: true, force: true }));

let storeCount = 0;
const freshMemory = (options: { project?: string; maxEntries?: number } = {}) =>
	new TeamMemory({ memoryRoot, project: options.project ?? `store-${storeCount++}`, maxEntries: options.maxEntries });

describe("TeamMemory", () => {
	test("projectKeyFromCwd is stable, filename-safe, and path-sensitive", () => {
		expect(projectKeyFromCwd("/a/b/my proj!")).toBe(projectKeyFromCwd("/a/b/my proj!"));
		expect(projectKeyFromCwd("/a/b/my proj!")).toMatch(/^my-proj--[0-9a-f]{8}$/);
		expect(projectKeyFromCwd("/a/b/app")).not.toBe(projectKeyFromCwd("/c/d/app"));
	});

	test("write/get/list/remove round-trip and persist across instances", async () => {
		const memory = freshMemory({ project: "roundtrip" });
		await memory.write("auth/approach", "use refresh tokens", { tags: ["auth"], role: "coder" });
		await memory.write("style", "tabs not spaces");

		expect((await memory.get("auth/approach"))?.value).toBe("use refresh tokens");
		expect((await memory.list()).map((entry) => entry.key)).toEqual(["auth/approach", "style"]);

		// A second instance over the same file sees the same entries.
		const reopened = new TeamMemory({ memoryRoot, project: "roundtrip" });
		expect((await reopened.get("auth/approach"))?.tags).toEqual(["auth"]);

		expect(await memory.remove("style")).toBe(true);
		expect(await memory.remove("style")).toBe(false);
		expect(await memory.get("style")).toBeUndefined();
	});

	test("re-writing a key updates the value, keeps createdAt, and refreshes recency", async () => {
		const memory = freshMemory();
		const first = await memory.write("k", "v1");
		await memory.write("other", "x");
		const second = await memory.write("k", "v2");
		expect(second.createdAt).toBe(first.createdAt);
		expect(second.value).toBe("v2");
		// refreshed recency: "k" is now the most recently written entry
		expect((await memory.list()).map((entry) => entry.key)).toEqual(["other", "k"]);
	});

	test("evicts the least recently written entries beyond maxEntries", async () => {
		const memory = freshMemory({ maxEntries: 2 });
		await memory.write("a", "1");
		await memory.write("b", "2");
		await memory.write("c", "3");
		expect((await memory.list()).map((entry) => entry.key)).toEqual(["b", "c"]);
	});

	test("read ranks by matched tokens with recency tiebreak; empty query returns newest", async () => {
		const memory = freshMemory();
		await memory.write("auth/tokens", "we use refresh tokens for auth", { tags: ["auth"] });
		await memory.write("style/indent", "tabs not spaces");
		await memory.write("auth/provider", "auth goes through okta", { tags: ["auth", "okta"] });

		const matches = await memory.read("auth okta");
		expect(matches[0]?.key).toBe("auth/provider"); // matches both tokens
		expect(matches[1]?.key).toBe("auth/tokens");
		expect(matches.some((entry) => entry.key === "style/indent")).toBe(false);

		const newest = await memory.read("", 2);
		expect(newest.map((entry) => entry.key)).toEqual(["auth/provider", "style/indent"]);
	});

	test("recordTask stores a settled task's output and skips tasks without one", async () => {
		const memory = freshMemory();
		await memory.recordTask({ runId: "r1", taskId: "build", role: "coder", status: "done", output: "built it" });
		await memory.recordTask({ runId: "r1", taskId: "broken", role: "coder", status: "error", output: undefined });
		const entries = await memory.list();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ key: "run/r1/build", value: "built it", tags: ["coder", "done"], runId: "r1" });
	});

	test("bootstrapContext digests recent entries and is undefined when empty", async () => {
		const memory = freshMemory();
		expect(await memory.bootstrapContext()).toBeUndefined();
		await memory.write("oldest", "o");
		await memory.write("newest", "n", { tags: ["t"] });
		const context = await memory.bootstrapContext(1);
		expect(context).toContain("previous runs");
		expect(context).toContain("newest [t]: n");
		expect(context).not.toContain("oldest");
	});

	test("bootstrapContext injects only the most recent run plus run-agnostic knowledge", async () => {
		const memory = freshMemory();
		// Two older runs and the newest run, written in chronological order.
		await memory.recordTask({ runId: "r1", taskId: "design", role: "planner", status: "done", output: "old design" });
		await memory.recordTask({ runId: "r1", taskId: "build", role: "coder", status: "done", output: "old build" });
		await memory.write("conventions/style", "tabs not spaces", { tags: ["convention"] }); // run-agnostic
		await memory.recordTask({ runId: "r2", taskId: "design", role: "planner", status: "done", output: "new design" });
		await memory.recordTask({ runId: "r2", taskId: "build", role: "coder", status: "done", output: "new build" });

		const context = await memory.bootstrapContext();
		// Most recent run's outputs are present…
		expect(context).toContain("new design");
		expect(context).toContain("new build");
		// …run-agnostic knowledge (no runId) survives…
		expect(context).toContain("tabs not spaces");
		// …but older runs' logs are excluded.
		expect(context).not.toContain("old design");
		expect(context).not.toContain("old build");
		expect(context).not.toContain("run/r1/");
	});

	test("append accumulates lines and concurrent appends never lose each other", async () => {
		const memory = freshMemory({ project: "append" });
		// Fire many appends to one key at once; whole-value write() would clobber,
		// but the serialized read-modify-write of append() keeps every line.
		await Promise.all(Array.from({ length: 25 }, (_, i) => memory.append("conflicts", `item-${i}`, { tags: ["board"] })));
		const entry = await memory.get("conflicts");
		const lines = entry!.value.split("\n");
		expect(lines).toHaveLength(25);
		expect(new Set(lines).size).toBe(25);
	});

	test("a corrupt store file yields an empty store instead of an error", async () => {
		const memory = freshMemory({ project: "corrupt" });
		await Bun.write(memory.file, "not json{");
		expect(await memory.list()).toEqual([]);
		await memory.write("k", "v");
		expect(JSON.parse(await readFile(memory.file, "utf8")).entries).toHaveLength(1);
	});
});

describe("memory tools", () => {
	test("memory_write then memory_read round-trip through tool execution", async () => {
		const memory = freshMemory();
		const writeTool = createMemoryWriteTool(memory, { runId: "run-1", role: "coder" });
		const readTool = createMemoryReadTool(memory);

		const written = await writeTool.execute("call-1", { key: "db/choice", value: "sqlite, single file", tags: ["db"] } as any);
		expect(JSON.stringify(written.content)).toContain("db/choice");
		expect((await memory.get("db/choice"))?.role).toBe("coder");

		const found = await readTool.execute("call-2", { query: "sqlite" } as any);
		expect(JSON.stringify(found.content)).toContain("single file");
		expect((found.details as any).matches).toBe(1);

		const missing = await readTool.execute("call-3", { query: "zzz-nothing" } as any);
		expect(JSON.stringify(missing.content)).toContain("No memory entries match");
	});
});

// Minimal NodeHarness fake: every prompt finishes immediately with one assistant message.
function echoHarness(reply: (text: string) => string) {
	return (node: TaskNode) => {
		const listeners = new Set<(event: AgentEvent) => Promise<void> | void>();
		const prompts: string[] = [];
		return {
			prompts,
			harness: {
				prompt: async (text: string) => {
					prompts.push(text);
					const message = { role: "assistant", content: [{ type: "text", text: reply(text) }], timestamp: Date.now() } as unknown as AgentMessage;
					for (const listener of listeners) void listener({ type: "agent_end", messages: [message] });
				},
				steer: () => {},
				subscribe: (listener: (event: AgentEvent) => Promise<void> | void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		};
	};
}

describe("coordination board tools", () => {
	test("board tools are run-scoped, list by prefix, and stay out of bootstrap", async () => {
		const memory = freshMemory({ project: "board" });
		const tools = createBoardTools(memory, { runId: "run-1", role: "worker" });
		const read = tools[0]!;
		const write = tools[1]!;
		const append = tools[2]!;

		await write.execute("c1", { key: "task/storage", value: "done" } as any);
		await append.execute("c2", { key: "conflict/list", item: "dup type Foo" } as any);
		await append.execute("c3", { key: "conflict/list", item: "path mismatch" } as any);

		const all = await read.execute("c4", {} as any);
		expect(JSON.stringify(all.content)).toContain("task/storage");
		expect(JSON.stringify(all.content)).toContain("dup type Foo");
		expect(JSON.stringify(all.content)).toContain("path mismatch");

		// Prefix narrows to one section.
		const conflicts = await read.execute("c5", { prefix: "conflict/" } as any);
		expect(JSON.stringify(conflicts.content)).toContain("path mismatch");
		expect(JSON.stringify(conflicts.content)).not.toContain("task/storage");

		// Run scoping: another run's board sees nothing of run-1's.
		const readRun2 = createBoardTools(memory, { runId: "run-2", role: "worker" })[0]!;
		expect((await readRun2.execute("c6", {} as any)).details).toMatchObject({ entries: 0 });

		// Board entries are transient and must not leak into a later run's bootstrap.
		expect(await memory.bootstrapContext()).toBeUndefined();
	});
});

describe("TeamOrchestrator memory integration", () => {
	test("bootstraps root prompts from prior runs and records task outputs at run end", async () => {
		const memory = freshMemory();
		const repo = new InMemorySessionRepo();

		// First run on the project: no prior memory, outputs get recorded.
		{
			const dag = new TaskDag();
			dag.add({ id: "research", role: "researcher" });
			dag.add({ id: "build", role: "coder", deps: ["research"] });
			const make = echoHarness((text) => `did: ${text.split("\n")[0]}`);
			const prompts: Record<string, string[]> = {};
			const orchestrator = new TeamOrchestrator(dag, {
				session: await repo.create(),
				createHarness: (node) => {
					const handle = make(node);
					prompts[node.id] = handle.prompts;
					return handle;
				},
				memory: { bootstrapContext: await memory.bootstrapContext(), recordTask: (task) => memory.recordTask(task) },
			});
			await orchestrator.run();

			expect(prompts.research![0]).toBe("research"); // empty store: no bootstrap section
			const keys = (await memory.list()).map((entry) => entry.key);
			expect(keys).toContain(`run/${orchestrator.runId}/research`);
			expect(keys).toContain(`run/${orchestrator.runId}/build`);
		}

		// Second run: root task prompts carry the first run's outputs; dependent tasks don't.
		{
			const dag = new TaskDag();
			dag.add({ id: "improve", role: "coder" });
			dag.add({ id: "verify", role: "tester", deps: ["improve"] });
			const make = echoHarness(() => "ok");
			const prompts: Record<string, string[]> = {};
			const orchestrator = new TeamOrchestrator(dag, {
				session: await repo.create(),
				createHarness: (node) => {
					const handle = make(node);
					prompts[node.id] = handle.prompts;
					return handle;
				},
				memory: { bootstrapContext: await memory.bootstrapContext(), recordTask: (task) => memory.recordTask(task) },
			});
			await orchestrator.run();

			expect(prompts.improve![0]).toContain("Shared team memory from previous runs");
			expect(prompts.improve![0]).toContain("did: research");
			expect(prompts.verify![0]).not.toContain("Shared team memory");
		}
	});

	test("a throwing memory store surfaces team_error but the run still completes", async () => {
		const dag = new TaskDag();
		dag.add({ id: "only", role: "coder" });
		const errors: string[] = [];
		const { TeamChannel } = await import("../src/channel.js");
		const channel = new TeamChannel();
		channel.subscribe((event) => {
			if (event.type === "team_error") errors.push(event.error);
		});
		const orchestrator = new TeamOrchestrator(dag, {
			session: await new InMemorySessionRepo().create(),
			channel,
			createHarness: echoHarness(() => "ok"),
			memory: {
				recordTask: () => {
					throw new Error("disk full");
				},
			},
		});
		await orchestrator.run();
		expect(dag.get("only")?.status).toBe("done");
		expect(errors.some((error) => error.includes("disk full"))).toBe(true);
	});
});
