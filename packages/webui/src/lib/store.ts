import { create } from "zustand";
import type { AgentState, ConnectionStatus, TeamEvent, ToolChipState } from "./types";

interface Store {
	agents: Map<string, AgentState>;
	connection: ConnectionStatus;
	setConnection: (status: ConnectionStatus) => void;
	dispatch: (event: TeamEvent) => void;
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
	connection: "connecting",
	setConnection: (status) => set({ connection: status }),
	dispatch: (event) =>
		set((state) => {
			const agents = new Map(state.agents);
			const current = agents.get(event.role) ?? emptyAgent(event.role, event.agentId);
			agents.set(event.role, reduce(current, event));
			return { agents };
		}),
}));
