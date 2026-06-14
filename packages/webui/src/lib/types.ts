/**
 * Wire types for the HooTeams SSE stream. Re-declared here on purpose —
 * the web UI has no build dependency on the orchestrator; the contract is the
 * JSON shape documented in packages/bridge.
 */

export interface TeamTag {
	role: string;
	agentId: string;
	ts: number;
}

export interface UsageSummary {
	input?: number;
	output?: number;
	cost?: { total?: number };
}

export interface WireMessage {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: UsageSummary;
	errorMessage?: string;
}

/** Streaming delta — the bridge strips the accumulated `partial`. */
export interface AssistantDelta {
	type:
		| "start"
		| "text_start"
		| "text_delta"
		| "text_end"
		| "thinking_start"
		| "thinking_delta"
		| "thinking_end"
		| "toolcall_start"
		| "toolcall_delta"
		| "toolcall_end"
		| "done"
		| "error";
	contentIndex?: number;
	delta?: string;
	content?: string;
}

export type TeamEvent = TeamTag &
	(
		| { type: "agent_start" }
		| { type: "agent_end"; messages?: WireMessage[] }
		| { type: "turn_start" }
		| { type: "turn_end"; message?: WireMessage; toolResults?: unknown[] }
		| { type: "message_start"; message?: WireMessage }
		| { type: "message_update"; assistantMessageEvent?: AssistantDelta }
		| { type: "message_end"; message?: WireMessage }
		| { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
		| { type: "tool_execution_update"; toolCallId: string; toolName: string; partialResult?: unknown }
		| { type: "tool_execution_end"; toolCallId: string; toolName: string; result?: unknown; isError?: boolean }
	);

export type AgentStatus = "idle" | "thinking" | "streaming" | "tool" | "done" | "error";

export type ToolChipStatus = "running" | "done" | "error";

export interface ToolChipState {
	toolCallId: string;
	toolName: string;
	status: ToolChipStatus;
	args?: unknown;
	partialResult?: unknown;
	result?: unknown;
}

export interface TurnSummary {
	text: string;
	thinking: string;
	tools: ToolChipState[];
	usage?: UsageSummary;
	error?: string;
}

/** A nudge (steer message) that landed in the agent's transcript. */
export interface NudgeEntry {
	kind: "nudge";
	text: string;
}

export interface TurnEntry extends TurnSummary {
	kind: "turn";
}

export type TranscriptEntry = TurnEntry | NudgeEntry;

export interface AgentState {
	role: string;
	agentId: string;
	status: AgentStatus;
	streamBuffer: string;
	thinkingBuffer: string;
	activeTools: ToolChipState[];
	transcript: TranscriptEntry[];
	/** Timestamp of the last event, drives the signal-sweep animation. */
	lastEventTs: number;
}

export type ConnectionStatus = "connecting" | "live" | "reconnecting";

// ── DAG / Session Replay Types ──

export type TaskStatus = "idle" | "pending" | "running" | "done" | "error" | "retrying";

export interface DagNode {
	id: string;
	role: string;
	deps: string[];
	status: TaskStatus;
	retries?: number;
	advisor?: boolean;
	gate?: boolean;
	results?: unknown[];
}

export interface DagState {
	[taskId: string]: DagNode;
}

export interface SessionRunConfig {
	runId: string;
	tasks: Array<{
		id: string;
		role: string;
		prompt?: string;
		deps?: string[];
		retries?: number;
	}>;
	goal?: string;
}

export interface SessionEntry {
	type: string;
	customType?: string;
	data?: Record<string, unknown>;
	timestamp?: string;
}

export interface RunInfo {
	runId: string;
	goal?: string;
	dag: DagState;
	status: "running" | "done" | "error";
	startedAt?: number;
	endedAt?: number;
}
