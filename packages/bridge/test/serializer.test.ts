import { describe, expect, test } from "bun:test";
import type { TeamEvent } from "@kolisachint/hooteams-orchestrator";
import { safeStringify, serializeTeamEvent, toWire } from "../src/serializer.js";

const tag = { role: "coder", agentId: "id-1", ts: 1000 };

describe("toWire", () => {
	test("message_update keeps the delta but strips the accumulated partial", () => {
		const partial = { role: "assistant", content: [{ type: "text", text: "Hello wor" }] };
		const event = {
			...tag,
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor", partial },
		} as unknown as TeamEvent;

		const wire = toWire(event) as { assistantMessageEvent: Record<string, unknown>; message?: unknown };
		expect(wire.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "wor" });
		expect(wire.message).toBeUndefined();
	});

	test("tool_execution_update sends only the partial result", () => {
		const event = {
			...tag,
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "run_tests",
			args: { huge: "payload" },
			partialResult: { content: [{ type: "text", text: "3 passing" }] },
		} as unknown as TeamEvent;

		const wire = toWire(event) as Record<string, unknown>;
		expect(wire.partialResult).toEqual({ content: [{ type: "text", text: "3 passing" }] });
		expect(wire.args).toBeUndefined();
	});

	test("other events pass through with the team tag", () => {
		const event = { ...tag, type: "agent_start" } as TeamEvent;
		expect(toWire(event)).toEqual({ type: "agent_start", ...tag });
	});

	test("task_paused carries the approval gate over the wire", () => {
		const event: TeamEvent = {
			...tag,
			type: "task_paused",
			taskId: "deploy",
			question: "Ship it?",
			options: ["yes", "no"],
		};
		expect(toWire(event)).toEqual({
			type: "task_paused",
			...tag,
			taskId: "deploy",
			question: "Ship it?",
			options: ["yes", "no"],
		});
	});

	test("dag settlement events pass through with their runId", () => {
		const event: TeamEvent = { type: "dag_complete", runId: "run-1", role: "orchestrator", agentId: "run-1", ts: 1000 };
		expect(toWire(event)).toEqual({
			type: "dag_complete",
			runId: "run-1",
			role: "orchestrator",
			agentId: "run-1",
			ts: 1000,
		});
	});
});

describe("safeStringify", () => {
	test("drops functions, AbortSignals, and circular references", () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		const value = {
			ok: 1,
			fn: () => {},
			signal: new AbortController().signal,
			circular,
		};
		expect(JSON.parse(safeStringify(value))).toEqual({ ok: 1, circular: { name: "loop" } });
	});
});

describe("serializeTeamEvent", () => {
	test("produces a well-formed SSE frame", () => {
		const frame = serializeTeamEvent({ ...tag, type: "agent_start" } as TeamEvent);
		expect(frame.startsWith("data: ")).toBe(true);
		expect(frame.endsWith("\n\n")).toBe(true);
		expect(JSON.parse(frame.slice("data: ".length))).toMatchObject({ type: "agent_start", role: "coder" });
	});
});
