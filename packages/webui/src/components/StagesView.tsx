/** The live run monitor: the workflow as a graph / timeline of stages, plus the
 *  activity feed. The shell owns view state, the inspector and the run totals. */
import { useMemo } from "react";
import { type MissionState, taskTimings } from "../lib/mission";
import { fmtT, statColor } from "../lib/roles";
import type { ConnectionStatus, FeedEvent } from "../lib/types";
import { DagGraph } from "./DagGraph";
import { Feed } from "./Feed";
import { Icon } from "./Icon";
import { Ring } from "./Ring";
import { Timeline } from "./Timeline";

export type StageLayout = "graph" | "timeline" | "feed";

const RUN_PILL: Record<MissionState["run"]["status"], string> = {
	running: "running",
	gated: "gate",
	done: "done",
	error: "error",
};

export function StagesView({
	mission,
	connection,
	elapsedSec,
	view,
	setView,
	minimap,
	sel,
	onSelect,
	events,
	feedFilter,
	setFeedFilter,
}: {
	mission: MissionState;
	connection: ConnectionStatus;
	elapsedSec: number;
	view: StageLayout;
	setView: (v: StageLayout) => void;
	minimap: boolean;
	sel: string | null;
	onSelect: (id: string | null) => void;
	events: FeedEvent[];
	feedFilter: string;
	setFeedFilter: (r: string) => void;
}) {
	const { run } = mission;
	const timings = useMemo(() => taskTimings(events), [events]);
	const feedRoles = useMemo(() => [...new Set(events.map((e) => e.role))], [events]);

	return (
		<div className="app stages">
			<header className="header">
				<div className="run-id">
					<span className="ri-eye">run</span>
					<span className="ri-val">{run.runId}</span>
				</div>
				<div className="goalwrap">
					<div className="goal-eye">
						<span
							className="runpill"
							data-s={run.status === "gated" ? "gated" : run.status}
							style={{ "--sc": statColor(RUN_PILL[run.status]) } as React.CSSProperties}
						>
							<i className="dot" />
							{run.status}
						</span>
						<span className="conn" data-conn={connection}>
							<i className="dot" />
							{connection}
						</span>
					</div>
					<div className="goal-text" title={run.goal}>
						{run.goal ?? "Live multi-agent run"}
					</div>
				</div>
				<div className="hstats">
					<div className="hstat">
						<span className="k">progress</span>
						<span className="v" style={{ display: "flex", alignItems: "center", gap: 8 }}>
							<Ring value={run.progress} size={22} stroke={3} />
							{run.doneCount}/{run.total}
						</span>
					</div>
					<div className="hstat opt">
						<span className="k">elapsed</span>
						<span className="v">{fmtT(elapsedSec)}</span>
					</div>
					<div className="hstat">
						<span className="k">tokens</span>
						<span className="v">
							{(run.tokens / 1000).toFixed(1)}
							<small>k</small>
						</span>
					</div>
					{run.cost > 0 && (
						<div className="hstat opt">
							<span className="k">cost</span>
							<span className="v">${run.cost.toFixed(2)}</span>
						</div>
					)}
				</div>
			</header>

			<main className="stage">
				<div className="stage-bar">
					<div className="seg">
						<button type="button" className={view === "graph" ? "on" : ""} onClick={() => setView("graph")}>
							<Icon name="graph" size={14} />
							graph
						</button>
						<button type="button" className={view === "timeline" ? "on" : ""} onClick={() => setView("timeline")}>
							<Icon name="timeline" size={14} />
							timeline
						</button>
						<button type="button" className={view === "feed" ? "on" : ""} onClick={() => setView("feed")}>
							<Icon name="activity" size={14} />
							feed
						</button>
					</div>
					<div className="spacer" />
					{view === "feed" ? (
						<span className="stage-count">{events.length} events · live</span>
					) : (
						<div className="legend">
							<span>
								<i style={{ background: "var(--accent)" }} />
								running
							</span>
							<span>
								<i style={{ background: "var(--ok)" }} />
								done
							</span>
							<span>
								<i style={{ background: "var(--warn)" }} />
								review
							</span>
							<span>
								<i style={{ background: "var(--err)" }} />
								error
							</span>
							<span>
								<i style={{ background: "var(--ink-4)" }} />
								queued
							</span>
						</div>
					)}
				</div>

				{view === "feed" ? (
					<Feed
						events={events}
						startedAt={run.startedAt}
						filter={feedFilter}
						onFilter={setFeedFilter}
						filters={feedRoles}
					/>
				) : (
					<div className="stage-body">
						{run.gatePending && mission.tasks[run.gatePending] && (
							<div className="gate-banner">
								<span className="gi">
									<Icon name="lock" size={16} />
								</span>
								<div className="gt">
									<b>Approval gate — {mission.tasks[run.gatePending]!.label}</b>
									<span>
										{mission.tasks[run.gatePending]!.role} is paused. The run can't continue until you
										approve.
									</span>
								</div>
								<div className="ga">
									<button type="button" className="btn sm primary" onClick={() => onSelect(run.gatePending)}>
										<Icon name="check" size={13} />
										review
									</button>
								</div>
							</div>
						)}
						{mission.taskList.length === 0 ? (
							<div className="stage-empty">
								<span className="se-mark">
									<Icon name="graph" size={22} />
								</span>
								<div className="se-title">Waiting for a run</div>
								<div className="se-sub">
									The task graph will appear here once an orchestrated run attaches to this stream.
								</div>
							</div>
						) : view === "graph" ? (
							<DagGraph
								taskList={mission.taskList}
								selectedId={sel}
								onSelect={(id) => onSelect(id)}
								showMinimap={minimap}
							/>
						) : (
							<Timeline
								taskList={mission.taskList}
								timings={timings}
								startedAt={run.startedAt}
								elapsedSec={elapsedSec}
								selectedId={sel}
								onSelect={(id) => onSelect(id)}
							/>
						)}
					</div>
				)}
			</main>
		</div>
	);
}
