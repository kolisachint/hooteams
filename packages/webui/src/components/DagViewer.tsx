import { useMemo, useState } from "react";
import type { DagNode, DagState, RunInfo, TaskStatus } from "../lib/types";

// ── Status colors — matching hoocowork paper & ink semantic palette ──
const STATUS_COLORS: Record<TaskStatus, string> = {
	idle: "var(--text-faint)",
	pending: "var(--line-bright)",
	running: "var(--cyan)",
	done: "#6FA98A",
	error: "#D9788A",
	retrying: "#D6A84F",
};

const STATUS_BG: Record<TaskStatus, string> = {
	idle: "transparent",
	pending: "rgba(63, 63, 70, 0.15)",
	running: "var(--cyan-dim)",
	done: "rgba(111, 169, 138, 0.12)",
	error: "rgba(217, 120, 138, 0.12)",
	retrying: "rgba(214, 168, 79, 0.12)",
};

// ── Layout constants ──
const NODE_W = 172;
const NODE_H = 60;
const GAP_X = 72;
const GAP_Y = 76;
const PADDING = 48;

/** Compute topological layers for vertical layout. */
function computeLayers(dag: DagState): string[][] {
	const inDegree = new Map<string, number>();
	const children = new Map<string, string[]>();

	for (const [id, node] of Object.entries(dag)) {
		inDegree.set(id, node.deps.length);
		for (const dep of node.deps) {
			if (!children.has(dep)) children.set(dep, []);
			const list = children.get(dep);
			if (list) list.push(id);
		}
	}

	const layers: string[][] = [];
	const dagKeys = Object.keys(dag);
	const queue = dagKeys.filter((id) => (inDegree.get(id) ?? 0) === 0);

	while (queue.length > 0) {
		const layer = [...queue];
		layers.push(layer);
		const next: string[] = [];
		for (const id of layer) {
			const childList = children.get(id);
			if (childList) {
				for (const child of childList) {
					const deg = (inDegree.get(child) ?? 1) - 1;
					inDegree.set(child, deg);
					if (deg === 0) next.push(child);
				}
			}
		}
		queue.length = 0;
		queue.push(...next);
	}

	return layers;
}

/** Compute node positions from layers. */
function computePositions(layers: string[][]): Map<string, { x: number; y: number }> {
	const positions = new Map<string, { x: number; y: number }>();
	const maxLayerLen = Math.max(...layers.map((l) => l.length));

	for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
		const layer = layers[layerIdx];
		if (!layer) continue;
		const layerLen = layer.length;
		const totalW = layerLen * NODE_W + (layerLen - 1) * GAP_X;
		const startX = (maxLayerLen * (NODE_W + GAP_X) - GAP_X - totalW) / 2;

		for (let i = 0; i < layerLen; i++) {
			const nodeId = layer[i];
			if (nodeId) {
				positions.set(nodeId, {
					x: PADDING + startX + i * (NODE_W + GAP_X),
					y: PADDING + layerIdx * (NODE_H + GAP_Y),
				});
			}
		}
	}

	return positions;
}

/** SVG edge path — cubic bezier for smooth flow. */
function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
	const x1 = from.x + NODE_W / 2;
	const y1 = from.y + NODE_H;
	const x2 = to.x + NODE_W / 2;
	const y2 = to.y;
	const midY = (y1 + y2) / 2;
	return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

// ── Single node card ──
function DagNodeCard({
	node,
	position,
	isSelected,
	onClick,
}: {
	node: DagNode;
	position: { x: number; y: number };
	isSelected: boolean;
	onClick: () => void;
}) {
	const color = STATUS_COLORS[node.status];
	const bg = STATUS_BG[node.status];
	const busy = node.status === "running";

	return (
		// biome-ignore lint/a11y/useSemanticElements: SVG <g> cannot be <button>
		<g
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") onClick();
			}}
			role="button"
			tabIndex={0}
			style={{ cursor: "pointer" }}
			className="card-in"
		>
			{/* glow ring for running */}
			{busy && (
				<rect
					x={position.x - 3}
					y={position.y - 3}
					width={NODE_W + 6}
					height={NODE_H + 6}
					rx={6}
					fill="none"
					stroke={color}
					strokeWidth={1}
					opacity={0.35}
					className="presence"
				/>
			)}
			{/* main card — tight 4px radius per paper & ink */}
			<rect
				x={position.x}
				y={position.y}
				width={NODE_W}
				height={NODE_H}
				rx={4}
				fill={bg}
				stroke={isSelected ? "var(--cyan)" : "var(--line)"}
				strokeWidth={isSelected ? 1.5 : 1}
			/>
			{/* role label */}
			<text
				x={position.x + 12}
				y={position.y + 24}
				fill={color}
				fontSize={13}
				fontWeight={600}
				fontFamily='"JetBrains Mono Variable", "JetBrains Mono", monospace'
				letterSpacing="0.02em"
			>
				{node.role}
			</text>
			{/* status + meta */}
			<text
				x={position.x + 12}
				y={position.y + 42}
				fill="var(--text-faint)"
				fontSize={10}
				fontFamily='"JetBrains Mono Variable", "JetBrains Mono", monospace'
				letterSpacing="0.06em"
			>
				{node.status}
				{node.retries ? `  ·  ${node.retries}r` : ""}
			</text>
			{/* status dot — 6px per kit spec */}
			<circle cx={position.x + NODE_W - 16} cy={position.y + 16} r={3} fill={color} />
			{busy && <circle cx={position.x + NODE_W - 16} cy={position.y + 16} r={3} fill={color} className="presence" />}
			{/* gate badge */}
			{node.gate && (
				<rect
					x={position.x + NODE_W - 42}
					y={position.y + 32}
					width={30}
					height={16}
					rx={2}
					fill="rgba(214, 168, 79, 0.15)"
					stroke="#D6A84F"
					strokeWidth={0.5}
				/>
			)}
			{node.gate && (
				<text
					x={position.x + NODE_W - 37}
					y={position.y + 43}
					fill="#D6A84F"
					fontSize={8}
					fontFamily='"JetBrains Mono Variable", "JetBrains Mono", monospace'
					letterSpacing="0.06em"
				>
					GATE
				</text>
			)}
		</g>
	);
}

// ── Detail panel ──
function TaskDetail({ node, runInfo }: { node: DagNode; runInfo: RunInfo }) {
	return (
		<div
			className="rounded p-4 mt-3"
			style={{
				border: "1px solid var(--line)",
				background: "var(--panel-raised)",
				borderRadius: "4px",
			}}
		>
			{/* header */}
			<div className="flex items-center gap-2 mb-3">
				<span
					className="status-dot"
					style={{ background: STATUS_COLORS[node.status], width: 6, height: 6, borderRadius: 999, flexShrink: 0 }}
				/>
				<h3 className="text-[14px] font-semibold" style={{ color: "var(--text)", letterSpacing: "-0.005em" }}>
					{node.role}
				</h3>
				<span
					className="ml-auto text-[10px] uppercase"
					style={{
						color: STATUS_COLORS[node.status],
						letterSpacing: "0.12em",
						fontWeight: 600,
					}}
				>
					{node.status}
				</span>
			</div>

			{/* metadata grid */}
			<div
				className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] mb-3 pb-3"
				style={{ borderBottom: "1px solid var(--line)", color: "var(--text-dim)" }}
			>
				<div>
					<span style={{ color: "var(--text-faint)" }}>task </span>
					{node.id}
				</div>
				<div>
					<span style={{ color: "var(--text-faint)" }}>deps </span>
					{node.deps.length > 0 ? node.deps.join(", ") : "—"}
				</div>
				{node.retries !== undefined && (
					<div>
						<span style={{ color: "var(--text-faint)" }}>retries </span>
						{node.retries}
					</div>
				)}
				{node.gate && <div style={{ color: "#D6A84F" }}>⚠ approval gate</div>}
				{node.advisor && <div style={{ color: "var(--cyan)" }}>◆ advisor</div>}
			</div>

			{/* goal */}
			{runInfo.goal && (
				<div className="mb-3">
					<div
						className="text-[10px] uppercase mb-1"
						style={{ color: "var(--text-faint)", letterSpacing: "0.12em", fontWeight: 600 }}
					>
						Goal
					</div>
					<div className="text-[12px] whitespace-pre-wrap leading-relaxed" style={{ color: "var(--text-dim)" }}>
						{runInfo.goal}
					</div>
				</div>
			)}

			{/* transcript */}
			{node.results && node.results.length > 0 && (
				<div>
					<div
						className="text-[10px] uppercase mb-2"
						style={{ color: "var(--text-faint)", letterSpacing: "0.12em", fontWeight: 600 }}
					>
						Transcript · {node.results.length} messages
					</div>
					<div className="max-h-72 overflow-y-auto space-y-2">
						{node.results.map((msg: any, i: number) => {
							if (msg.role === "user") {
								const text = msg.content?.map((c: any) => c.text ?? "").join("") ?? "";
								return (
									<div
										key={i}
										className="text-[11px] pl-3 py-1"
										style={{
											color: "var(--cyan)",
											borderLeft: "2px solid var(--cyan)",
										}}
									>
										{text.slice(0, 250)}
										{text.length > 250 ? "…" : ""}
									</div>
								);
							}
							if (msg.role === "assistant") {
								const thinking = msg.content?.find((c: any) => c.type === "thinking")?.thinking ?? "";
								const text =
									msg.content
										?.filter((c: any) => c.type === "text")
										.map((c: any) => c.text ?? "")
										.join("") ?? "";
								const tools = msg.content?.filter((c: any) => c.type === "toolCall") ?? [];
								return (
									<div key={i} className="pl-3 py-1" style={{ borderLeft: "1px solid var(--line)" }}>
										{thinking && (
											<div className="text-[10px] italic mb-1" style={{ color: "var(--text-faint)" }}>
												{thinking.slice(0, 180)}
												{thinking.length > 180 ? "…" : ""}
											</div>
										)}
										{text && (
											<div
												className="text-[11px] whitespace-pre-wrap leading-relaxed"
												style={{ color: "var(--text-dim)" }}
											>
												{text.slice(0, 400)}
												{text.length > 400 ? "…" : ""}
											</div>
										)}
										{tools.length > 0 && (
											<div className="flex flex-wrap gap-1 mt-1.5">
												{tools.map((t: any, j: number) => (
													<span
														key={j}
														className="chip text-[9px]"
														style={{
															color: "#D6A84F",
															border: "1px solid rgba(214, 168, 79, 0.3)",
															borderRadius: 999,
															padding: "1px 6px",
														}}
													>
														{t.name}
													</span>
												))}
											</div>
										)}
									</div>
								);
							}
							if (msg.role === "toolResult") {
								return (
									<div key={i} className="text-[10px] pl-3" style={{ color: "var(--text-faint)" }}>
										← {msg.toolName}: {(msg.content?.[0]?.text ?? "").slice(0, 120)}
									</div>
								);
							}
							return null;
						})}
					</div>
				</div>
			)}
		</div>
	);
}

// ── Main DAG viewer ──
export function DagViewer({ runInfo }: { runInfo: RunInfo }) {
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const layers = useMemo(() => computeLayers(runInfo.dag), [runInfo.dag]);
	const positions = useMemo(() => computePositions(layers), [layers]);

	const svgW = useMemo(() => {
		let max = 0;
		for (const pos of positions.values()) {
			max = Math.max(max, pos.x + NODE_W + PADDING);
		}
		return max;
	}, [positions]);

	const svgH = useMemo(() => {
		let max = 0;
		for (const pos of positions.values()) {
			max = Math.max(max, pos.y + NODE_H + PADDING);
		}
		return max;
	}, [positions]);

	const selectedNode = selectedId ? runInfo.dag[selectedId] : null;

	const statusColor = runInfo.status === "done" ? "#6FA98A" : runInfo.status === "error" ? "#D9788A" : "var(--cyan)";

	return (
		<div
			className="rounded overflow-hidden"
			style={{
				border: "1px solid var(--line)",
				background: "var(--panel)",
				borderRadius: "4px",
			}}
		>
			{/* header — eyebrow pattern */}
			<div
				className="flex items-center gap-3 px-4 py-3"
				style={{ borderBottom: "1px solid var(--line)", background: "var(--panel-raised)" }}
			>
				<span
					className="text-[10px] uppercase font-semibold"
					style={{ color: "var(--text-faint)", letterSpacing: "0.12em" }}
				>
					Task Graph
				</span>
				<span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
					{runInfo.runId.slice(0, 12)}
				</span>
				<span
					className="ml-auto text-[10px] uppercase font-semibold"
					style={{ color: statusColor, letterSpacing: "0.12em" }}
				>
					{runInfo.status}
				</span>
			</div>

			{/* DAG canvas */}
			<div className="overflow-auto p-4" style={{ background: "var(--bg)" }}>
				<svg width={svgW} height={svgH} style={{ minWidth: "100%" }} role="img" aria-label="Task dependency graph">
					{/* edges */}
					{Object.entries(runInfo.dag).map(([id, node]) => {
						const toPos = positions.get(id);
						if (!toPos) return null;
						return node.deps.map((depId) => {
							const fromPos = positions.get(depId);
							if (!fromPos) return null;
							const fromNode = runInfo.dag[depId];
							const edgeColor =
								fromNode?.status === "done"
									? "#6FA98A"
									: fromNode?.status === "running"
										? "var(--cyan)"
										: "var(--line-bright)";
							return (
								<path
									key={`${depId}-${id}`}
									d={edgePath(fromPos, toPos)}
									fill="none"
									stroke={edgeColor}
									strokeWidth={1}
									strokeDasharray={fromNode?.status === "done" ? "none" : "3 3"}
									opacity={0.5}
								/>
							);
						});
					})}

					{/* nodes */}
					{Object.entries(runInfo.dag).map(([id, node]) => {
						const pos = positions.get(id);
						if (!pos) return null;
						return (
							<DagNodeCard
								key={id}
								node={node}
								position={pos}
								isSelected={selectedId === id}
								onClick={() => setSelectedId(selectedId === id ? null : id)}
							/>
						);
					})}
				</svg>
			</div>

			{/* detail panel */}
			{selectedNode && (
				<div className="px-4 pb-4">
					<TaskDetail node={selectedNode} runInfo={runInfo} />
				</div>
			)}
		</div>
	);
}
