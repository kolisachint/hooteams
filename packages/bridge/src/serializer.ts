import type { TeamEvent } from "@kolisachint/hooteams-orchestrator";

/**
 * Shape a TeamEvent for the wire.
 *
 * - message_update: the assistantMessageEvent's `partial` (the full
 *   accumulated message so far) and the event's own `message` copy are
 *   stripped — only the delta crosses the wire, the client accumulates.
 * - tool_execution_update: only the partial result, not prior accumulation.
 * - everything else passes through, scrubbed of unserializable values.
 */
export function toWire(event: TeamEvent): Record<string, unknown> {
	const tag = { type: event.type, role: event.role, agentId: event.agentId, ts: event.ts };
	switch (event.type) {
		case "message_update": {
			const { partial: _partial, ...delta } = event.assistantMessageEvent as Record<string, unknown> & {
				partial?: unknown;
			};
			return { ...tag, assistantMessageEvent: delta };
		}
		case "tool_execution_update":
			return {
				...tag,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				partialResult: event.partialResult,
			};
		default: {
			const { role: _r, agentId: _a, ts: _t, type: _ty, ...rest } = event;
			return { ...tag, ...rest };
		}
	}
}

/** JSON.stringify that drops functions, AbortSignals, and circular references. */
export function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, val) => {
		if (typeof val === "function" || val instanceof AbortSignal) return undefined;
		if (typeof val === "object" && val !== null) {
			if (seen.has(val)) return undefined;
			seen.add(val);
		}
		return val;
	});
}

/** Full SSE frame for one TeamEvent: `data: {json}\n\n`. */
export function serializeTeamEvent(event: TeamEvent): string {
	return `data: ${safeStringify(toWire(event))}\n\n`;
}
