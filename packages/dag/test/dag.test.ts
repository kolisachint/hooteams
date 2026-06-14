import { describe, expect, test } from "bun:test";
import { TaskDag } from "../src/dag.js";

function diamond(): TaskDag {
	// plan → (code, docs) → test
	const dag = new TaskDag();
	dag.add({ id: "plan", role: "planner" });
	dag.add({ id: "code", role: "coder", deps: ["plan"] });
	dag.add({ id: "docs", role: "writer", deps: ["plan"] });
	dag.add({ id: "test", role: "tester", deps: ["code", "docs"] });
	return dag;
}

describe("topologicalOrder", () => {
	test("orders dependencies before dependents", () => {
		const order = diamond().topologicalOrder();
		expect(order.indexOf("plan")).toBeLessThan(order.indexOf("code"));
		expect(order.indexOf("plan")).toBeLessThan(order.indexOf("docs"));
		expect(order.indexOf("code")).toBeLessThan(order.indexOf("test"));
		expect(order.indexOf("docs")).toBeLessThan(order.indexOf("test"));
		expect(order).toHaveLength(4);
	});

	test("throws on cycles", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x", deps: ["b"] });
		dag.add({ id: "b", role: "y", deps: ["a"] });
		expect(() => dag.topologicalOrder()).toThrow(/cycle/);
	});

	test("throws on unknown dependency", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x", deps: ["ghost"] });
		expect(() => dag.topologicalOrder()).toThrow(/unknown task "ghost"/);
	});

	test("rejects duplicate ids", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x" });
		expect(() => dag.add({ id: "a", role: "y" })).toThrow(/already exists/);
	});
});

describe("dependentsOf", () => {
	test("returns transitive descendants and nothing for a leaf", () => {
		const dag = diamond();
		expect(new Set(dag.dependentsOf("plan"))).toEqual(new Set(["code", "docs", "test"]));
		expect(new Set(dag.dependentsOf("code"))).toEqual(new Set(["test"]));
		expect(dag.dependentsOf("test")).toEqual([]);
	});
});

describe("markDone propagation", () => {
	test("only roots are ready initially", () => {
		expect(diamond().ready().map((node) => node.id)).toEqual(["plan"]);
	});

	test("completing a node returns newly ready nodes only", () => {
		const dag = diamond();
		const unblocked = dag.markDone("plan");
		expect(unblocked.map((node) => node.id).sort()).toEqual(["code", "docs"]);

		// test needs both code and docs — finishing just code unblocks nothing
		expect(dag.markDone("code")).toEqual([]);
		expect(dag.markDone("docs").map((node) => node.id)).toEqual(["test"]);
	});

	test("running nodes are not reported ready", () => {
		const dag = diamond();
		dag.markDone("plan");
		dag.markRunning("code");
		expect(dag.ready().map((node) => node.id)).toEqual(["docs"]);
	});

	test("stores results on the node", () => {
		const dag = diamond();
		const messages = [{ role: "user" as const, content: "done", timestamp: Date.now() }];
		dag.markDone("plan", messages);
		expect(dag.get("plan")?.results).toEqual(messages);
	});

	test("failed nodes block their descendants", () => {
		const dag = diamond();
		dag.markDone("plan");
		dag.markFailed("code");
		expect(dag.blocked().map((node) => node.id)).toEqual(["test"]);
		// docs is unaffected and still ready
		expect(dag.ready().map((node) => node.id)).toEqual(["docs"]);
		expect(dag.isComplete()).toBe(false);
		dag.markDone("docs");
		expect(dag.isComplete()).toBe(true);
	});
});

describe("paused nodes", () => {
	test("paused nodes are neither ready nor complete", () => {
		const dag = diamond();
		dag.markDone("plan");
		dag.markRunning("code");
		dag.markPaused("code");
		expect(dag.get("code")?.status).toBe("paused");
		expect(dag.ready().map((node) => node.id)).toEqual(["docs"]);
		dag.markDone("docs");
		// code is paused and test depends on it — the dag stays open
		expect(dag.isComplete()).toBe(false);
		dag.markRunning("code");
		dag.markDone("code");
		dag.markDone("test");
		expect(dag.isComplete()).toBe(true);
	});

	test("paused status round-trips through toJSON/fromJSON", () => {
		const dag = diamond();
		dag.markDone("plan");
		dag.markPaused("code");
		const restored = TaskDag.fromJSON(JSON.parse(JSON.stringify(dag.toJSON())));
		expect(restored.get("code")?.status).toBe("paused");
	});

	test("resetTransient reverts mid-run nodes to idle but keeps paused and done", () => {
		const dag = diamond();
		dag.markDone("plan");
		dag.markRunning("code", "streaming");
		dag.markPaused("docs");
		const reset = dag.resetTransient();
		expect(reset.map((node) => node.id)).toEqual(["code"]);
		expect(dag.get("code")?.status).toBe("idle");
		expect(dag.get("docs")?.status).toBe("paused");
		expect(dag.get("plan")?.status).toBe("done");
	});
});

describe("retries and rework", () => {
	test("add() records the retry budget on the node", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x", retries: 2 });
		expect(dag.get("a")?.retries).toBe(2);
	});

	test("resetToIdle re-arms a settled node, clearing results and output but not attempts", () => {
		const dag = diamond();
		dag.markDone("plan", [{ role: "user", content: "done", timestamp: 1 } as any]);
		dag.setOutput("plan", "the plan");
		dag.incrementAttempts("plan");
		expect(dag.get("plan")?.output).toBe("the plan");

		const node = dag.resetToIdle("plan");

		expect(node.status).toBe("idle");
		expect(node.results).toBeUndefined();
		expect(node.output).toBeUndefined();
		expect(node.attempts).toBe(1);
		expect(dag.ready().map((other) => other.id)).toEqual(["plan"]);
		expect(dag.isComplete()).toBe(false);
	});

	test("incrementAttempts counts up and returns the running total", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x" });
		expect(dag.incrementAttempts("a")).toBe(1);
		expect(dag.incrementAttempts("a")).toBe(2);
		expect(dag.get("a")?.attempts).toBe(2);
	});
});

describe("immutable snapshots", () => {
	test("accessors hand back frozen copies, so external writes never leak into the dag", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x" });
		const node = dag.get("a")!;
		expect(Object.isFrozen(node)).toBe(true);
		expect(() => {
			(node as any).output = "leak";
		}).toThrow();
		// the dag's own state is untouched by the rejected write
		expect(dag.get("a")?.output).toBeUndefined();
	});

	test("mutating a returned node's deps array does not change the dag", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x", deps: [] });
		const node = dag.get("a")!;
		node.deps.push("ghost");
		expect(dag.get("a")?.deps).toEqual([]);
	});

	test("mutating a returned node's results array does not change the dag", () => {
		const dag = new TaskDag();
		dag.add({ id: "a", role: "x" });
		dag.markDone("a", [{ role: "assistant", content: "one", timestamp: 1 } as any]);
		const node = dag.get("a")!;
		node.results!.push({ role: "user", content: "leak", timestamp: 2 } as any);
		expect(dag.get("a")?.results).toHaveLength(1);
	});
});

describe("persistence", () => {
	test("toJSON/fromJSON round-trips nodes, statuses, and results", () => {
		const dag = diamond();
		dag.markDone("plan", [{ role: "user", content: [{ type: "text", text: "done" }], timestamp: 1 } as any]);
		dag.markRunning("code");

		const restored = TaskDag.fromJSON(JSON.parse(JSON.stringify(dag.toJSON())));

		expect(restored.all()).toEqual(dag.all());
		expect(restored.get("plan")?.results).toEqual(dag.get("plan")?.results);
		// derived state survives the round trip: code is running, docs is ready
		expect(restored.ready().map((node) => node.id)).toEqual(["docs"]);
	});

	test("a node reset after producing output round-trips cleanly", () => {
		const dag = diamond();
		dag.markDone("plan");
		dag.setOutput("plan", "the plan");
		dag.resetToIdle("plan");

		const restored = TaskDag.fromJSON(JSON.parse(JSON.stringify(dag.toJSON())));

		// resetToIdle clears output/results by removing them, so the serialized
		// shape is stable: no explicit-undefined keys to drop on the round trip.
		expect(restored.all()).toEqual(dag.all());
		expect(dag.get("plan")?.output).toBeUndefined();
	});

	test("the restored dag is independent of the source", () => {
		const dag = diamond();
		const restored = TaskDag.fromJSON(dag.toJSON());
		restored.markDone("plan");
		expect(restored.get("plan")?.status).toBe("done");
		expect(dag.get("plan")?.status).toBe("idle");
	});

});
