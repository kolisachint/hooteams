/**
 * Mission-control adapter.
 *
 * The cockpit components want a single coherent view-model — tasks, an agent
 * roster, and run-level totals — that always agree. This module folds the live
 * store (`runInfo` + `agents` + `pending`) into that shape, derives a
 * longest-path graph layout, and reconstructs per-task timing from the feed so
 * the timeline reads even though the wire never sends durations.
 */

import { agentMissionStatus, humanize, type MissionStatus, roleInfo } from "./roles";
import type { AgentState, DagState, FeedEvent, PendingApproval, RunInfo, TranscriptEntry } from "./types";

export interface MissionTask {
	id: string;
	role: string;
	label: string;
	deps: string[];
	gate: boolean;
	advisor: boolean;
	retries: number;
	status: MissionStatus;
	progress: number;
	indeterminate: boolean;
}

export interface MissionAgent {
	role: string;
	status: MissionStatus;
	line: string;
	tokens: number;
	cost: number;
	taskId: string | null;
	transcript: TranscriptEntry[];
	streamBuffer: string;
	thinkingBuffer: string;
	live: boolean;
}

export interface MissionRun {
	runId: string;
	goal?: string;
	status: "running" | "done" | "error" | "gated";
	progress: number;
	doneCount: number;
	total: number;
	tokens: number;
	cost: number;
	gatePending: string | null;
	startedAt?: number;
	endedAt?: number;
}

export interface MissionState {
	tasks: Record<string, MissionTask>;
	taskList: MissionTask[];
	agents: Record<string, MissionAgent>;
	roles: string[];
	run: MissionRun;
}

function lastLine(text: string): string {
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	const line = lines.length > 0 ? lines[lines.length - 1]! : "";
	return line.length > 200 ? `…${line.slice(-200)}` : line;
}

function turnTokens(entry: TranscriptEntry): number {
	if (entry.kind !== "turn" || !entry.usage) return 0;
	return (entry.usage.input ?? 0) + (entry.usage.output ?? 0);
}

function turnCost(entry: TranscriptEntry): number {
	if (entry.kind !== "turn") return 0;
	return entry.usage?.cost?.total ?? 0;
}

/** Build the mission view-model from the live store slices. */
export function buildMission(
	runInfo: RunInfo | null,
	agents: Map<string, AgentState>,
	pending: Record<string, PendingApproval>,
): MissionState {
	const dag: DagState = runInfo?.dag ?? {};
	const ids = Object.keys(dag);

	// First pass: which tasks are done (for dependency readiness).
	const doneSet = new Set(ids.filter((id) => dag[id]!.status === "done"));

	const tasks: Record<string, MissionTask> = {};
	for (const id of ids) {
		const node = dag[id]!;
		const deps = node.deps ?? [];
		const depsDone = deps.every((d) => doneSet.has(d));
		const isPendingGate = !!pending[id] && !!node.gate;

		let status: MissionStatus;
		if (isPendingGate) {
			status = "gate";
		} else {
			switch (node.status) {
				case "running":
					status = "running";
					break;
				case "retrying":
					status = "retrying";
					break;
				case "done":
					status = "done";
					break;
				case "error":
					status = "error";
					break;
				default:
					status = depsDone ? "queued" : "blocked";
					break;
			}
		}

		const settled = status === "done" || status === "error" || status === "gate";
		const indeterminate = status === "running" || status === "retrying";
		tasks[id] = {
			id,
			role: node.role,
			label: humanize(id),
			deps,
			gate: !!node.gate,
			advisor: !!node.advisor,
			retries: node.retries ?? 0,
			status,
			progress: settled ? 1 : 0,
			indeterminate,
		};
	}
	const taskList = ids.map((id) => tasks[id]!);

	// Roster: every role that appears as an agent or owns a task.
	const roleSet = new Set<string>();
	for (const role of agents.keys()) roleSet.add(role);
	for (const t of taskList) roleSet.add(t.role);
	const roles = [...roleSet];

	const missionAgents: Record<string, MissionAgent> = {};
	for (const role of roles) {
		const agent = agents.get(role);
		const myTasks = taskList.filter((t) => t.role === role);
		const running = myTasks.find((t) => t.status === "running" || t.status === "retrying");
		const gateTask = myTasks.find((t) => t.status === "gate");

		let status: MissionStatus;
		if (gateTask) {
			status = "thinking";
		} else if (agent) {
			status = agentMissionStatus(agent.status);
		} else if (running) {
			status = "running";
		} else if (myTasks.length > 0 && myTasks.every((t) => t.status === "done")) {
			status = "done";
		} else {
			status = "idle";
		}

		let line = "";
		if (agent) {
			line = lastLine(agent.streamBuffer) || lastLine(agent.thinkingBuffer);
			if (!line) {
				for (let i = agent.transcript.length - 1; i >= 0 && !line; i--) {
					const turn = agent.transcript[i]!;
					if (turn.kind === "turn") line = lastLine(turn.text) || lastLine(turn.thinking);
					else line = turn.text;
				}
			}
		}
		if (gateTask) line = "awaiting your approval…";
		if (!line) line = roleInfo(role).desc;

		const transcript = agent?.transcript ?? [];
		const tokens = transcript.reduce((s, t) => s + turnTokens(t), 0);
		const cost = transcript.reduce((s, t) => s + turnCost(t), 0);
		const taskId =
			(running ?? gateTask ?? myTasks.find((t) => t.status !== "done") ?? myTasks[myTasks.length - 1])?.id ?? null;

		missionAgents[role] = {
			role,
			status,
			line,
			tokens,
			cost,
			taskId,
			transcript,
			streamBuffer: agent?.streamBuffer ?? "",
			thinkingBuffer: agent?.thinkingBuffer ?? "",
			live: status === "running" || status === "streaming" || status === "tool" || status === "thinking",
		};
	}

	const total = taskList.length;
	const doneCount = taskList.filter((t) => t.status === "done").length;
	const gatePending = taskList.find((t) => t.status === "gate")?.id ?? null;
	const tokens = Object.values(missionAgents).reduce((s, a) => s + a.tokens, 0);
	const cost = Object.values(missionAgents).reduce((s, a) => s + a.cost, 0);

	let runStatus: MissionRun["status"];
	if (runInfo?.status === "error" || taskList.some((t) => t.status === "error")) runStatus = "error";
	else if (gatePending) runStatus = "gated";
	else if (runInfo?.status === "done" || (total > 0 && doneCount === total)) runStatus = "done";
	else runStatus = "running";

	const run: MissionRun = {
		runId: runInfo?.runId ?? "—",
		goal: runInfo?.goal,
		status: runStatus,
		progress: total > 0 ? doneCount / total : 0,
		doneCount,
		total,
		tokens,
		cost,
		gatePending,
		startedAt: runInfo?.startedAt,
		endedAt: runInfo?.endedAt,
	};

	return { tasks, taskList, agents: missionAgents, roles, run };
}

// ── Graph layout (longest-path layering) ──────────────────────────────────────

export interface GraphLayout {
	pos: Record<string, { x: number; y: number }>;
	depth: Record<string, number>;
	width: number;
	height: number;
}

const COLW = 168;
const ROWH = 96;
const X0 = 76;
const Y0 = 66;

export function layout(taskList: MissionTask[]): GraphLayout {
	const byId: Record<string, MissionTask> = {};
	for (const t of taskList) byId[t.id] = t;
	const depth: Record<string, number> = {};
	const resolve = (id: string, seen: Set<string>): number => {
		if (depth[id] != null) return depth[id]!;
		if (seen.has(id)) return 0; // cycle guard
		seen.add(id);
		const task = byId[id];
		const deps = (task?.deps ?? []).filter((d) => byId[d]);
		depth[id] = deps.length > 0 ? 1 + Math.max(...deps.map((d) => resolve(d, seen))) : 0;
		return depth[id]!;
	};
	for (const t of taskList) resolve(t.id, new Set());

	const cols: Record<number, string[]> = {};
	for (const t of taskList) {
		const d = depth[t.id]!;
		let col = cols[d];
		if (!col) {
			col = [];
			cols[d] = col;
		}
		col.push(t.id);
	}
	const colKeys = Object.keys(cols).map(Number);
	const maxRows = Math.max(1, ...colKeys.map((c) => cols[c]!.length));
	const midY = Y0 + ((maxRows - 1) * ROWH) / 2;
	const pos: Record<string, { x: number; y: number }> = {};
	for (const c of colKeys) {
		const list = cols[c]!;
		const span = (list.length - 1) * ROWH;
		list.forEach((id, i) => {
			pos[id] = { x: X0 + c * COLW, y: midY - span / 2 + i * ROWH };
		});
	}
	const width = X0 + Math.max(0, colKeys.length - 1) * COLW + 120;
	const height = Y0 * 2 + (maxRows - 1) * ROWH;
	return { pos, depth, width, height };
}

// ── Timeline timing (reconstructed from the feed) ─────────────────────────────

export interface TaskTiming {
	start?: number;
	end?: number;
}

/** Per-task first-start / last-finish timestamps (ms), from the feed. */
export function taskTimings(events: FeedEvent[]): Record<string, TaskTiming> {
	const out: Record<string, TaskTiming> = {};
	for (const e of events) {
		if (!e.taskId) continue;
		let t = out[e.taskId];
		if (!t) {
			t = {};
			out[e.taskId] = t;
		}
		if (e.kind === "start" && t.start == null) t.start = e.ts;
		if ((e.kind === "done" || e.kind === "error") && (t.end == null || e.ts > t.end)) t.end = e.ts;
	}
	return out;
}
