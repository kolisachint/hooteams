import { describe, expect, test } from "bun:test";
import { InMemorySessionRepo } from "@kolisachint/hoocode-agent-core";
import { ApprovalRegistry, askOptions } from "../src/ask-options.js";

describe("ApprovalRegistry", () => {
	test("ask resolves with the answer passed to resolve", async () => {
		const registry = new ApprovalRegistry();
		const answer = registry.ask({ taskId: "t1", question: "Deploy?", options: ["yes", "no"] });
		expect(registry.has("t1")).toBe(true);
		expect(registry.resolve("t1", "yes")).toBe(true);
		expect(await answer).toBe("yes");
		expect(registry.has("t1")).toBe(false);
	});

	test("first answer wins; later and unknown answers report stale", async () => {
		const registry = new ApprovalRegistry();
		const answer = registry.ask({ taskId: "t1", question: "Deploy?", options: ["yes", "no"] });
		expect(registry.resolve("t1", "no")).toBe(true);
		expect(registry.resolve("t1", "yes")).toBe(false);
		expect(registry.resolve("nope", "yes")).toBe(false);
		expect(await answer).toBe("no");
	});

	test("rejects a second gate for the same task", () => {
		const registry = new ApprovalRegistry();
		void registry.ask({ taskId: "t1", question: "Deploy?", options: ["yes"] }).then(() => {});
		expect(() => registry.ask({ taskId: "t1", question: "Again?", options: ["yes"] })).toThrow(/pending approval/);
		registry.resolve("t1", "yes");
	});

	test("timeout falls back to defaultOption when given", async () => {
		const registry = new ApprovalRegistry();
		const answer = registry.ask({ taskId: "t1", question: "Deploy?", options: ["yes", "no"], timeoutMs: 5, defaultOption: "no" });
		expect(await answer).toBe("no");
		expect(registry.has("t1")).toBe(false);
	});

	test("timeout without defaultOption rejects", async () => {
		const registry = new ApprovalRegistry();
		const answer = registry.ask({ taskId: "t1", question: "Deploy?", options: ["yes", "no"], timeoutMs: 5 });
		await expect(answer).rejects.toThrow(/timed out/);
	});

	test("pendingRequests snapshots unanswered gates", () => {
		const registry = new ApprovalRegistry();
		void registry.ask({ taskId: "a", question: "Q1?", options: ["x"] }).then(() => {});
		void registry.ask({ taskId: "b", question: "Q2?", options: ["y"] }).then(() => {});
		registry.resolve("a", "x");
		expect(registry.pendingRequests().map((request) => request.taskId)).toEqual(["b"]);
		registry.resolve("b", "y");
	});
});

describe("askOptions", () => {
	test("persists the gate and its answer to the session", async () => {
		const session = await new InMemorySessionRepo().create();
		const registry = new ApprovalRegistry();
		const answer = askOptions(registry, { taskId: "t1", question: "Deploy?", options: ["yes", "no"] }, session);
		// Writes are awaited before the gate registers; spin until it shows up.
		while (!registry.has("t1")) {
			await Bun.sleep(1);
		}
		registry.resolve("t1", "yes");
		expect(await answer).toBe("yes");

		const entries = await session.getEntries();
		const request = entries.find((entry) => entry.type === "custom" && entry.customType === "approval_request");
		expect(request).toBeDefined();
		expect((request as any).data).toMatchObject({ taskId: "t1", question: "Deploy?", options: ["yes", "no"] });
		const display = entries.find((entry) => entry.type === "custom_message");
		expect(display).toMatchObject({ customType: "approval_request", display: true });
		expect((display as any).content).toContain("Deploy?");
		const response = entries.find((entry) => entry.type === "custom" && entry.customType === "approval_response");
		expect((response as any).data).toMatchObject({ taskId: "t1", chosenOption: "yes" });
	});

	test("works without a session", async () => {
		const registry = new ApprovalRegistry();
		const answer = askOptions(registry, { taskId: "t1", question: "Deploy?", options: ["yes"] });
		await Bun.sleep(0);
		registry.resolve("t1", "yes");
		expect(await answer).toBe("yes");
	});
});
