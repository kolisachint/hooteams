/** Gantt timeline. Live runs reconstruct per-task timing from the feed; when a
 *  task has no recorded start (e.g. replay), it falls back to a schematic
 *  position keyed off its dependency depth so the chart still reads. */
import { useMemo } from "react";
import { layout, type MissionTask, type TaskTiming } from "../lib/mission";
import { roleInfo, statColor } from "../lib/roles";

export function Timeline({
	taskList,
	timings,
	startedAt,
	elapsedSec,
	selectedId,
	onSelect,
}: {
	taskList: MissionTask[];
	timings: Record<string, TaskTiming>;
	startedAt?: number;
	elapsedSec: number;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const L = useMemo(() => layout(taskList), [taskList]);

	const sched: Record<string, { start: number; end: number }> = {};
	for (const t of taskList) {
		const tm = timings[t.id];
		let start: number;
		if (tm?.start != null && startedAt != null) start = (tm.start - startedAt) / 1000;
		else start = (L.depth[t.id] ?? 0) * 9;
		let end: number;
		if (tm?.end != null && startedAt != null) end = (tm.end - startedAt) / 1000;
		else if (t.status === "running" || t.status === "retrying") end = Math.max(start + 1, elapsedSec);
		else if (t.status === "done" || t.status === "gate" || t.status === "error") end = start + 6;
		else end = start;
		sched[t.id] = { start, end };
	}

	const maxEnd = Math.max(elapsedSec, 20, ...taskList.map((t) => sched[t.id]!.end));
	const span = maxEnd + 4;
	const pct = (x: number) => (x / span) * 100;
	const ticks: number[] = [];
	for (let s = 0; s <= span; s += 10) ticks.push(s);

	return (
		<div className="timeline">
			<div className="tl-grid">
				{taskList.map((t) => {
					const { start, end } = sched[t.id]!;
					const ghost = t.status === "blocked" || t.status === "queued";
					const drawEnd =
						t.status === "running" || t.status === "retrying"
							? Math.min(end, Math.max(start + 1, elapsedSec))
							: end;
					const left = pct(start);
					const width = Math.max(1.5, pct(drawEnd) - pct(start));
					return (
						<div
							className="tl-row"
							key={t.id}
							data-s={t.status}
							style={{ "--sc": statColor(t.status) } as React.CSSProperties}
						>
							<div className="tl-label">
								<span className="g">{roleInfo(t.role).glyph}</span>
								<span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</span>
							</div>
							<div className="tl-track">
								<button
									type="button"
									className="tl-bar"
									data-s={t.status}
									onClick={() => onSelect(t.id)}
									style={{
										left: `${left}%`,
										width: `${width}%`,
										opacity: ghost ? 0.4 : 1,
										borderStyle: ghost ? "dashed" : "solid",
										outline: selectedId === t.id ? "1.5px solid var(--ink)" : "none",
									}}
								>
									<span className="fill" style={{ width: `${t.progress * 100}%` }} />
									<span className="lab">
										{t.gate ? "⚿ " : ""}
										{t.label}
									</span>
								</button>
							</div>
						</div>
					);
				})}
				<div className="tl-axis">
					<div />
					<div className="tl-ticks">
						{ticks.map((s) => (
							<span key={s} className="tl-tick" style={{ left: `${pct(s)}%` }}>
								{s}s
							</span>
						))}
						<div className="tl-now" style={{ left: `${pct(elapsedSec)}%` }} />
					</div>
				</div>
			</div>
		</div>
	);
}
