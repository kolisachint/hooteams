/** Task DAG as HTML nodes overlaid on SVG dependency edges, plus a run-map. */
import { useMemo } from "react";
import { type GraphLayout, layout, type MissionTask } from "../lib/mission";
import { STAT_LABEL, statColor } from "../lib/roles";

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
	const dx = Math.max(40, (b.x - a.x) * 0.5);
	return `M ${a.x + 66} ${a.y} C ${a.x + 66 + dx} ${a.y}, ${b.x - 66 - dx} ${b.y}, ${b.x - 66} ${b.y}`;
}

function Minimap({ L, taskList }: { L: GraphLayout; taskList: MissionTask[] }) {
	return (
		<div className="minimap">
			<span className="mm-title">run map</span>
			<svg viewBox={`0 0 ${L.width} ${L.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
				{taskList.flatMap((t) =>
					t.deps
						.filter((d) => L.pos[d])
						.map((d) => {
							const a = L.pos[d]!;
							const b = L.pos[t.id]!;
							return (
								<line
									key={`${t.id}-${d}`}
									x1={a.x}
									y1={a.y}
									x2={b.x}
									y2={b.y}
									stroke="var(--line-2)"
									strokeWidth="2"
								/>
							);
						}),
				)}
				{taskList.map((t) => {
					const p = L.pos[t.id]!;
					return <circle key={t.id} className="mm-node" cx={p.x} cy={p.y} r="11" fill={statColor(t.status)} />;
				})}
			</svg>
		</div>
	);
}

export function DagGraph({
	taskList,
	selectedId,
	onSelect,
	showMinimap = true,
}: {
	taskList: MissionTask[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	showMinimap?: boolean;
}) {
	const L = useMemo(() => layout(taskList), [taskList]);
	const edges = taskList.flatMap((t) => t.deps.filter((d) => L.pos[d]).map((d) => ({ from: d, to: t.id })));

	return (
		<div className="graph" style={{ width: L.width, height: L.height, minHeight: "100%" }}>
			<svg className="edges" viewBox={`0 0 ${L.width} ${L.height}`} preserveAspectRatio="none" aria-hidden="true">
				{edges.map((e) => {
					const a = L.pos[e.from]!;
					const b = L.pos[e.to]!;
					const from = taskList.find((t) => t.id === e.from)!;
					const to = taskList.find((t) => t.id === e.to)!;
					const flow = from.status === "done" && (to.status === "running" || to.status === "retrying");
					const done = from.status === "done" && to.status === "done";
					return (
						<path
							key={`${e.from}-${e.to}`}
							className={`edge${flow ? " flow" : done ? " done" : ""}`}
							d={edgePath(a, b)}
						/>
					);
				})}
			</svg>
			{taskList.map((t) => {
				const p = L.pos[t.id]!;
				return (
					<button
						type="button"
						key={t.id}
						className={`node${selectedId === t.id ? " sel" : ""}`}
						data-s={t.status}
						style={{ left: p.x, top: p.y, "--sc": statColor(t.status) } as React.CSSProperties}
						onClick={() => onSelect(t.id)}
					>
						<div className="node-top">
							<span className="node-role">{t.role}</span>
							{t.gate && <span className="node-badge gate">gate</span>}
							{t.advisor && <span className="node-badge adv">adv</span>}
						</div>
						<div className="node-label">{t.label}</div>
						<div className={`node-prog${t.indeterminate ? " indeterminate" : ""}`}>
							<i style={{ width: `${t.progress * 100}%` }} />
						</div>
						<div className="node-stat">
							<span>{STAT_LABEL[t.status]}</span>
							<i className="dot" />
						</div>
					</button>
				);
			})}
			{showMinimap && <Minimap L={L} taskList={taskList} />}
		</div>
	);
}
