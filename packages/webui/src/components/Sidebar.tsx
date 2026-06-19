/**
 * Left sidebar: live run + run history, collapsible.
 *
 * Ported from the design handoff's project→run tree, adapted for the real
 * backend: hooteams runs one orchestrator per process (no multi-project
 * concept), so this renders a flat, searchable run list instead of nested
 * project groups. The live run comes from the store (no extra fetch); every
 * other row comes from the server's GET /sessions summary in a single call —
 * the server reads each log once and folds in goal/status/done/total/startedAt,
 * so the sidebar never fetches or parses individual session files (only an
 * explicit replay, in app.tsx, reads a full file). Live = SSE, history = file.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { humanize } from "../lib/roles";
import { listSessions, type SessionListItem } from "../lib/session";
import { useStore } from "../lib/store";
import { fetchStatus, HOOTEAMS_HOST, HOOTEAMS_HOST_LABEL } from "../lib/stream";
import type { RunInfo } from "../lib/types";
import { Icon } from "./Icon";

const MOBILE_BREAKPOINT = 860;
const STATUS_POLL_MS = 5_000;

interface RunRow {
	runId: string;
	title: string;
	status: RunInfo["status"];
	done: number;
	total: number;
	startedAt?: number;
	isLive: boolean;
}

function dotClass(status: RunInfo["status"]): string {
	switch (status) {
		case "running":
			return "status-dot dot-busy";
		case "done":
			return "status-dot dot-ok";
		case "error":
			return "status-dot dot-err";
		default:
			return "status-dot dot-off";
	}
}

function taskCounts(dag: RunInfo["dag"]): { done: number; total: number } {
	const nodes = Object.values(dag);
	return { done: nodes.filter((n) => n.status === "done").length, total: nodes.length };
}

/** Row for the live run, built from the store's runInfo (no fetch). */
function liveRow(runId: string, info: RunInfo): RunRow {
	const { done, total } = taskCounts(info.dag);
	return {
		runId,
		title: info.goal || humanize(runId),
		status: info.status,
		done,
		total,
		startedAt: info.startedAt,
		isLive: true,
	};
}

/** Row for a historical run, built from the server's GET /sessions summary. */
function summaryRow(s: SessionListItem): RunRow {
	return {
		runId: s.runId,
		title: s.goal || humanize(s.runId),
		status: s.status ?? "done",
		done: s.done ?? 0,
		total: s.total ?? 0,
		startedAt: s.startedAt,
		isLive: false,
	};
}

export function Sidebar({
	onCollapse,
	selectedRunId,
	onSelectRun,
}: {
	onCollapse: () => void;
	selectedRunId: string | null;
	onSelectRun: (runId: string | null) => void;
}) {
	const runInfo = useStore((s) => s.runInfo);
	const connection = useStore((s) => s.connection);
	const [q, setQ] = useState("");
	const [history, setHistory] = useState<SessionListItem[]>([]);
	const [agentStatus, setAgentStatus] = useState<Record<string, { status: string }>>({});
	const searchRef = useRef<HTMLInputElement>(null);

	// The history rows come straight from the server's GET /sessions summary —
	// one call, no per-file fetch/parse (the server already read each log once).
	useEffect(() => {
		let cancelled = false;
		listSessions(HOOTEAMS_HOST).then((sessions) => {
			if (!cancelled) setHistory(sessions);
		});
		return () => {
			cancelled = true;
		};
	}, [runInfo?.runId]);

	// Poll /status for a real "N agents idle" footer line.
	useEffect(() => {
		let cancelled = false;
		const poll = () => {
			fetchStatus(HOOTEAMS_HOST)
				.then((snapshot) => {
					if (!cancelled) setAgentStatus(snapshot);
				})
				.catch(() => {});
		};
		poll();
		const id = setInterval(poll, STATUS_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, []);

	// ⌘K / Ctrl+K focuses the search box, matching the inline kbd hint.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				searchRef.current?.focus();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const rows = useMemo(() => {
		// Merge by runId so the freshest copy wins: the store's live runInfo (which
		// has up-to-the-second counts) overrides the same run's GET /sessions
		// summary, instead of the run appearing twice.
		const byId = new Map<string, RunRow>();
		for (const s of history) byId.set(s.runId, summaryRow(s));
		if (runInfo) {
			// The live runInfo is the "live" row only when nothing is selected for
			// replay; otherwise it's just the freshest copy of a historical row.
			const row = liveRow(runInfo.runId, runInfo);
			byId.set(runInfo.runId, selectedRunId ? { ...row, isLive: false } : row);
		}
		const list = [...byId.values()];
		list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
		return list;
	}, [runInfo, history, selectedRunId]);

	const filtered = q ? rows.filter((r) => r.title.toLowerCase().includes(q.toLowerCase())) : rows;

	const agents = Object.values(agentStatus);
	const idleCount = agents.filter((a) => a.status === "idle").length;

	const connDot = connection === "live" ? "dot-ok" : connection === "reconnecting" ? "dot-err" : "dot-busy";
	const connLabel = connection === "live" ? "online" : connection === "reconnecting" ? "reconnecting…" : "connecting…";

	const handleSelect = (row: RunRow) => {
		onSelectRun(row.isLive ? null : row.runId);
		if (window.innerWidth <= MOBILE_BREAKPOINT) onCollapse();
	};

	return (
		<aside className="sidebar">
			<div className="sidebar-header">
				<span className="sidebar-title">Runs</span>
				<div className="sidebar-head-actions">
					<button type="button" className="iconbtn" title="Start a new run — coming soon" disabled>
						<Icon name="plus" size={15} />
					</button>
					<button type="button" className="iconbtn nav-collapse" title="Collapse sidebar" onClick={onCollapse}>
						<Icon name="chevL" size={15} />
					</button>
				</div>
			</div>

			<div className="sidebar-search">
				<span className="input-prefix">
					<Icon name="search" size={13} />
				</span>
				<input
					ref={searchRef}
					className="input"
					placeholder="Search runs…"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<span className="kbd-inline">⌘K</span>
			</div>

			<div className="sidebar-runs">
				{filtered.length === 0 && <div className="session-empty">{q ? "no matches" : "no runs yet"}</div>}
				{filtered.map((row) => {
					const active = selectedRunId ? row.runId === selectedRunId : row.isLive;
					return (
						<button
							key={row.runId}
							type="button"
							className={`session-row${active ? " active" : ""}`}
							onClick={() => handleSelect(row)}
						>
							<span className={dotClass(row.status)} />
							<span className="session-title">{row.title}</span>
							<span className="session-meta">
								{row.total > 0 ? `${row.done}/${row.total} · ` : ""}
								{row.isLive && row.status === "running" ? "live" : row.status}
							</span>
						</button>
					);
				})}
			</div>

			<div className="sidebar-foot">
				<div className="foot-row">
					<span className={`status-dot ${connDot}`} />
					{connLabel}
					<span className="foot-meta">· {HOOTEAMS_HOST_LABEL}</span>
				</div>
				<div className="foot-row">
					<span className="foot-meta">
						{agents.length === 0 ? "no agents spawned" : `${agents.length} agents · ${idleCount} idle`}
					</span>
				</div>
			</div>
		</aside>
	);
}
