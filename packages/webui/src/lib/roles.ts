/**
 * Role registry + status helpers for the mission-control UI.
 *
 * The SSE wire identifies agents by an arbitrary `role` string. We map the
 * roles hooteams ships out of the box onto a glyph, a one-line description and
 * a semantic tint (reusing the design-system tokens so we never invent colors).
 * Unknown roles fall back to a neutral glyph and the accent tint.
 */

import type { AgentStatus, TaskStatus } from "./types";

/** A mission status is a task/agent status as the cockpit renders it. */
export type MissionStatus =
	| "idle"
	| "blocked"
	| "queued"
	| "running"
	| "streaming"
	| "tool"
	| "thinking"
	| "done"
	| "error"
	| "retrying"
	| "gate";

export interface RoleInfo {
	glyph: string;
	desc: string;
}

export const ROLES: Record<string, RoleInfo> = {
	orchestrator: { glyph: "◆", desc: "Lead — plans & ships" },
	planner: { glyph: "▤", desc: "Breaks goal into tasks" },
	backend: { glyph: "❯", desc: "API & data layer" },
	frontend: { glyph: "❮", desc: "UI & client" },
	tester: { glyph: "✓", desc: "Unit & e2e tests" },
	security: { glyph: "⌬", desc: "Advisor — reviews risk" },
	docs: { glyph: "¶", desc: "Writes the changelog" },
	reviewer: { glyph: "⌘", desc: "Reviews the work" },
};

export function roleInfo(role: string): RoleInfo {
	return ROLES[role] ?? { glyph: "▸", desc: "" };
}

/** role → semantic tint, by function family (lead=accent, build=info, …). */
const ROLE_TINT: Record<string, string> = {
	orchestrator: "var(--accent)",
	planner: "var(--accent)",
	backend: "var(--info)",
	frontend: "var(--info)",
	tester: "var(--ok)",
	reviewer: "var(--ok)",
	security: "var(--warn)",
	docs: "var(--ink-3)",
};

export function roleColor(role: string): string {
	return ROLE_TINT[role] ?? "var(--accent)";
}

export const STAT_LABEL: Record<MissionStatus, string> = {
	idle: "idle",
	blocked: "blocked",
	queued: "queued",
	running: "running",
	streaming: "streaming",
	tool: "tool call",
	thinking: "thinking",
	done: "done",
	error: "error",
	retrying: "retrying",
	gate: "needs approval",
};

export function statColor(s: string): string {
	const map: Record<string, string> = {
		done: "var(--ok)",
		running: "var(--accent)",
		streaming: "var(--accent)",
		retrying: "var(--err)",
		error: "var(--err)",
		gate: "var(--accent)",
		thinking: "var(--warn)",
		tool: "var(--info)",
		queued: "var(--ink-3)",
		blocked: "var(--ink-4)",
		idle: "var(--ink-4)",
	};
	return map[s] ?? "var(--ink-4)";
}

/** Map a live agent status onto a mission status (they already line up). */
export function agentMissionStatus(s: AgentStatus): MissionStatus {
	return s;
}

/** Turn a task id like `sec-review` into a readable label. */
export function humanize(id: string): string {
	const spaced = id.replace(/[_-]+/g, " ").trim();
	return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : id;
}

/** mm:ss for a number of seconds. */
export function fmtT(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const m = Math.floor(s / 60);
	const ss = s % 60;
	return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** Whether a status counts as "live" (animated dot / caret). */
export function isLive(s: string): boolean {
	return s === "running" || s === "streaming" || s === "tool" || s === "thinking";
}

/** TaskStatus → does this task still have work ahead of it? */
export function taskSettled(s: TaskStatus): boolean {
	return s === "done" || s === "error";
}
