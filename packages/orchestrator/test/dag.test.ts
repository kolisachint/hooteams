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
		expect(dag.get("plan")?.results).toBe(messages);
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

	test("the restored dag is independent of the source", () => {
		const dag = diamond();
		const restored = TaskDag.fromJSON(dag.toJSON());
		restored.markDone("plan");
		expect(restored.get("plan")?.status).toBe("done");
		expect(dag.get("plan")?.status).toBe("idle");
	});

});
