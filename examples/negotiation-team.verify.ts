#!/usr/bin/env bun
/**
 * Verifies that hooteams already supports the negotiation-first team pattern
 * with NO engine changes — using the real TeamOrchestrator + TaskDag +
 * TeamMemory, driven by scripted (no-API-key) agents.
 *
 *   bun run examples/negotiation-team.verify.ts
 *
 * It runs the DAG  scope → blueprint → {backend, frontend, qa} → integrate
 * with BridgeAgent as the run validator. On pass 1 the backend discovers the
 * blueprint can't satisfy its layer and posts a CONTRACT_CHANGE to the shared
 * board; Bridge (validator) sees the unresolved conflict and bounces the
 * `blueprint` node. The cascading-rework support then re-runs every
 * implementation branch against ArchAgent's revised blueprint v2, the conflict
 * resolves, Bridge passes, and the gated integrate node settles. This is the
 * negotiation loop realized as board-versioned state + validator rework, with
 * the graph re-running rather than mutating itself.
 */
import { InMemorySessionRepo, TaskDag, TeamChannel, TeamMemory, TeamOrchestrator } from "../packages/orchestrator/src/index.js";
import type { AgentEvent, AgentMessage, NodeHandle, TaskNode } from "../packages/orchestrator/src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assistant = (text: string): AgentMessage =>
	({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() }) as unknown as AgentMessage;

/** Minimal stand-in for AgentHarness: prompt() runs `script`, which ends the run. */
class FakeHarness {
	idle = true;
	private listeners = new Set<(event: AgentEvent) => void>();
	private finish?: (value: unknown) => void;
	constructor(private readonly script: (harness: FakeHarness) => Promise<void>) {}
	prompt(_text: string): Promise<unknown> {
		this.idle = false;
		return new Promise((resolve) => {
			this.finish = resolve;
			queueMicrotask(() => void this.script(this));
		});
	}
	steer(_text: string): void {
		if (this.idle) throw new Error("Cannot steer while idle");
	}
	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	endRun(text: string): void {
		for (const listener of this.listeners) listener({ type: "agent_end", messages: [assistant(text)] } as AgentEvent);
		this.idle = true;
		this.finish?.(undefined);
	}
}

async function main(): Promise<void> {
	const runId = "negotiation-demo";
	const memoryRoot = await mkdtemp(join(tmpdir(), "negotiation-"));
	const memory = new TeamMemory({ memoryRoot, project: "negotiation" });

	// Run-scoped board helpers (the same shape board_write/append/read produce).
	const bk = (key: string) => `board/${runId}/${key}`;
	const meta = (role: string) => ({ tags: ["board", role], runId, role });
	const post = (role: string, key: string, value: string) => memory.write(bk(key), value, meta(role));
	const append = (role: string, key: string, item: string) => memory.append(bk(key), item, meta(role));
	const get = (key: string) => memory.get(bk(key));
	const boardEntries = async () => (await memory.list()).filter((entry) => entry.key.startsWith(`board/${runId}/`));

	const transcript: string[] = [];
	const promptOrder: string[] = [];

	// One scripted "agent" per role. Behavior is driven entirely by shared board
	// state, exactly as real agents reading/writing the board would behave.
	const scripts: Record<string, (harness: FakeHarness) => Promise<void>> = {
		scope: async (h) => {
			await post("spec", "scope/lock", "NC-1: user profile must support KYC gating (testable)");
			h.endRun("Scope locked: NC-1 user profile + KYC gating");
		},
		blueprint: async (h) => {
			const conflicts = (await boardEntries()).filter((e) => e.key.includes("/conflict"));
			if (conflicts.length > 0) {
				await post("arch", "blueprint", "v2: add shared_type kyc_status enum; user profile carries kyc_status");
				for (const c of conflicts) await post("arch", `resolution/${c.key.split("/").pop()}`, "resolved in blueprint v2");
				h.endRun(`ArchAgent: published blueprint v2 resolving ${conflicts.length} conflict(s) (COMMIT_BLUEPRINT)`);
			} else {
				await post("arch", "blueprint", "v1: user profile (no kyc field)");
				h.endRun("ArchAgent: published blueprint v1");
			}
		},
		backend: async (h) => {
			const bp = await get("blueprint");
			if (bp?.value.includes("v1")) {
				await append("backend", "conflict/kyc", "BackendAgent: endpoint needs kyc_verified; missing from blueprint (CONTRACT_CHANGE)");
				h.endRun("BackendAgent: blocked on missing kyc contract — raised CONTRACT_CHANGE");
			} else {
				h.endRun(`BackendAgent: implemented against ${bp?.value}`);
			}
		},
		frontend: async (h) => {
			const bp = await get("blueprint");
			h.endRun(bp?.value.includes("v1") ? "FrontendAgent: awaiting kyc contract before modal" : `FrontendAgent: implemented against ${bp?.value}`);
		},
		qa: async (h) => {
			const bp = await get("blueprint");
			h.endRun(`QAAgent: failing tests written against ${bp?.value}`);
		},
		integrate: async (h) => h.endRun("Integrate: assembled service from current blueprint"),
	};

	const createHarness = (node: TaskNode): NodeHandle => {
		promptOrder.push(node.id);
		const fake = new FakeHarness(async (h) => {
			await scripts[node.role]!(h);
			transcript.push(`  ${node.id} (${node.role})`);
		});
		return { harness: fake, sessionId: `session-${node.id}` };
	};

	// BridgeAgent as the run validator: reads the board and fails the goal while
	// any conflict is unresolved, naming the shared blueprint node to re-run.
	const validator = {
		goal: "Backend and frontend contracts are compatible; all conflicts resolved.",
		validate: async (): Promise<string> => {
			const entries = await boardEntries();
			const open = entries.filter((e) => e.key.includes("/conflict")).length;
			const resolved = entries.filter((e) => e.key.includes("/resolution")).length;
			const verdict = open > resolved ? "GOAL_UNMET: contract conflict unresolved | blueprint" : "GOAL_MET";
			transcript.push(`  BridgeAgent (validator): ${verdict}`);
			return verdict;
		},
	};

	const dag = new TaskDag();
	dag.add({ id: "scope", role: "scope" });
	dag.add({ id: "blueprint", role: "blueprint", deps: ["scope"] });
	dag.add({ id: "backend", role: "backend", deps: ["blueprint"] });
	dag.add({ id: "frontend", role: "frontend", deps: ["blueprint"] });
	dag.add({ id: "qa", role: "qa", deps: ["blueprint"] });
	dag.add({ id: "integrate", role: "integrate", deps: ["backend", "frontend", "qa"], gate: true });

	const channel = new TeamChannel();
	const events: string[] = [];
	channel.subscribe((event) => {
		events.push(event.type);
		if (event.type === "task_paused") transcript.push(`  [human gate] ${event.taskId}: approving`);
	});

	const session = await new InMemorySessionRepo().create();
	const orchestrator = new TeamOrchestrator(dag, { session, channel, createHarness, validator, allowAutonomous: true, runId });

	// Auto-approve the per-task gate(s) on the integrate node as they open. Defer
	// to a microtask: the orchestrator registers the approval right *after* it
	// publishes task_paused, so resuming synchronously here would no-op.
	channel.subscribe((event) => {
		if (event.type === "task_paused") queueMicrotask(() => orchestrator.resume(event.taskId, "approve"));
	});

	await orchestrator.run();

	// ---- Report + assertions -------------------------------------------------
	console.log("Negotiation transcript (in settle order):");
	for (const line of transcript) console.log(line);
	console.log("\nFinal board:");
	for (const entry of await boardEntries()) console.log(`  ${entry.key.replace(`board/${runId}/`, "")} = ${entry.value}`);

	const blueprintRuns = promptOrder.filter((id) => id === "blueprint").length;
	const backendRuns = promptOrder.filter((id) => id === "backend").length;
	const finalBlueprint = (await get("blueprint"))?.value ?? "";
	const completed = events.at(-1) === "dag_complete";

	const checks: [string, boolean][] = [
		["run completed (dag_complete)", completed],
		["blueprint re-run after conflict (cascade)", blueprintRuns === 2],
		["backend re-run against revised blueprint (cascade)", backendRuns === 2],
		["blueprint converged to v2", finalBlueprint.includes("v2")],
		["integrate gate fired and was approved", events.includes("task_paused")],
	];
	console.log("\nChecks:");
	let ok = true;
	for (const [label, pass] of checks) {
		console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
		ok &&= pass;
	}

	await rm(memoryRoot, { recursive: true, force: true });
	if (!ok) {
		console.error("\nVERIFICATION FAILED");
		process.exit(1);
	}
	console.log("\nVERIFIED: hooteams supports the negotiation-first pattern with no engine changes.");
}

void main();
