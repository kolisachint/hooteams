import { create } from "zustand";
import type { AgentState, ConnectionStatus, DagNode, DagState, RunInfo, TaskStatus, TeamEvent, ToolChipState } from "./types";

interface Store {
	agents: Map<string, AgentState>;
	/** Live task graph for the active run, built from dag_snapshot + task_* events. */
	runInfo: RunInfo | null;
	connection: ConnectionStatus;
	setConnection: (status: ConnectionStatus) => void;
	dispatch: (event: TeamEvent) => void;
}

/** Map an orchestrator/agent status string onto the viewer's TaskStatus. */
function mapStatus(status: string): TaskStatus {
	switch (status) {
		case "running":
		case "streaming":
		case "thinking":
		case "tool":
			return "running";
		case "done":
		case "completed":
			return "done";
		case "error":
		case "failed":
			return "error";
		case "pending":
		case "paused":
			return "pending";
		case "retrying":
		case "retry":
			return "retrying";
		default:
			return "idle";
	}
}

function patchNode(runInfo: RunInfo, taskId: string, patch: Partial<DagNode>): RunInfo {
	const current = runInfo.dag[taskId];
	if (!current) return runInfo;
	const dag: DagState = { ...runInfo.dag, [taskId]: { ...current, ...patch } };
	return { ...runInfo, dag };
}

/** Fold run/dag-level events into the live task graph. */
function reduceRun(runInfo: RunInfo | null, event: TeamEvent): RunInfo | null {
	switch (event.type) {
		case "dag_snapshot": {
			const dag: DagState = {};
			for (const [taskId, node] of Object.entries(event.dag)) {
				dag[taskId] = {
					id: node.id ?? taskId,
					role: node.role ?? taskId,
					deps: node.deps ?? [],
					status: mapStatus(node.status),
					retries: node.retries,
					advisor: node.advisor,
					gate: node.gate,
					results: node.results,
				};
			}
			const settled = runInfo?.status === "done" || runInfo?.status === "error";
			return {
				runId: event.runId,
				goal: event.goal ?? runInfo?.goal,
				dag,
				status: settled ? runInfo.status : "running",
				startedAt: runInfo?.startedAt ?? event.ts,
			};
		}
		case "task_started":
			return runInfo ? patchNode(runInfo, event.taskId, { status: "running" }) : runInfo;
		case "task_finished":
			return runInfo ? patchNode(runInfo, event.taskId, { status: event.status }) : runInfo;
		case "task_retried": {
			if (!runInfo) return runInfo;
			const node = runInfo.dag[event.taskId];
			return patchNode(runInfo, event.taskId, { status: "retrying", retries: (node?.retries ?? 0) + 1 });
		}
		case "task_resumed":
			return runInfo ? patchNode(runInfo, event.taskId, { status: "running" }) : runInfo;
		case "dag_complete":
			return runInfo ? { ...runInfo, status: "done", endedAt: event.ts } : runInfo;
		case "dag_failed":
			return runInfo ? { ...runInfo, status: "error", endedAt: event.ts } : runInfo;
		default:
			return runInfo;
	}
}

function emptyAgent(role: string, agentId: string): AgentState {
	return {
		role,
		agentId,
		status: "idle",
		streamBuffer: "",
		thinkingBuffer: "",
		activeTools: [],
		transcript: [],
		lastEventTs: 0,
	};
}

function updateTool(
	tools: ToolChipState[],
	toolCallId: string,
	patch: Partial<ToolChipState> & Pick<ToolChipState, "toolName">,
): ToolChipState[] {
	const existing = tools.find((tool) => tool.toolCallId === toolCallId);
	if (!existing) {
		return [...tools, { toolCallId, status: "running", ...patch }];
	}
	return tools.map((tool) => (tool.toolCallId === toolCallId ? { ...tool, ...patch } : tool));
}

/** The single reducer: every SSE event flows through here. */
function reduce(agent: AgentState, event: TeamEvent): AgentState {
	const next: AgentState = { ...agent, agentId: event.agentId, lastEventTs: event.ts };
	switch (event.type) {
		case "agent_start":
			next.status = "thinking";
			return next;

		case "message_start":
		case "message_end": {
			// Steering messages surface as user messages mid-run — show them.
			if (event.type === "message_start" && event.message?.role === "user") {
				const text = event.message.content?.map((block) => block.text ?? "").join("") ?? "";
				if (text) next.transcript = [...next.transcript, { kind: "nudge", text }];
			}
			return next;
		}

		case "message_update": {
			const delta = event.assistantMessageEvent;
			if (!delta) return next;
			if (delta.type === "thinking_delta") {
				next.thinkingBuffer += delta.delta ?? "";
				next.status = "thinking";
			} else if (delta.type === "text_delta") {
				next.streamBuffer += delta.delta ?? "";
				next.status = "streaming";
			}
			return next;
		}

		case "tool_execution_start":
			next.status = "tool";
			next.activeTools = updateTool(next.activeTools, event.toolCallId, {
				toolName: event.toolName,
				status: "running",
				args: event.args,
			});
			return next;

		case "tool_execution_update":
			next.activeTools = updateTool(next.activeTools, event.toolCallId, {
				toolName: event.toolName,
				partialResult: event.partialResult,
			});
			return next;

		case "tool_execution_end":
			next.status = "thinking";
			next.activeTools = updateTool(next.activeTools, event.toolCallId, {
				toolName: event.toolName,
				status: event.isError ? "error" : "done",
				result: event.result,
			});
			return next;

		case "turn_end": {
			// Fold the live buffers into a completed turn so history stays visible.
			const error = event.message?.errorMessage;
			if (next.streamBuffer || next.thinkingBuffer || next.activeTools.length > 0 || error) {
				next.transcript = [
					...next.transcript,
					{
						kind: "turn",
						text: next.streamBuffer,
						thinking: next.thinkingBuffer,
						tools: next.activeTools,
						usage: event.message?.usage,
						error,
					},
				];
			}
			next.streamBuffer = "";
			next.thinkingBuffer = "";
			next.activeTools = [];
			if (error) next.status = "error";
			return next;
		}

		case "agent_end":
			if (next.status !== "error") next.status = "idle";
			return next;

		default:
			return next;
	}
}

export const useStore = create<Store>((set) => ({
	agents: new Map(),
	runInfo: null,
	connection: "connecting",
	setConnection: (status) => set({ connection: status }),
	dispatch: (event) =>
		set((state) => {
			const runInfo = reduceRun(state.runInfo, event);
			// Run/dag-level events (role "orchestrator") drive the task graph only —
			// they must not spawn an agent card.
			if (event.role === "orchestrator") return { runInfo };
			const agents = new Map(state.agents);
			const current = agents.get(event.role) ?? emptyAgent(event.role, event.agentId);
			agents.set(event.role, reduce(current, event));
			return { agents, runInfo };
		}),
}));
