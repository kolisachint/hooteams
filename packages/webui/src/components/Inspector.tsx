/** Slide-in inspector: task detail + agent detail + the agent transcript.
 *  Read-only by design — the one intervention is the human approval gate. */
import { useEffect, useRef, useState } from "react";
import type { MissionState, MissionTask } from "../lib/mission";
import { isLive, roleInfo, STAT_LABEL, statColor } from "../lib/roles";
import { useStore } from "../lib/store";
import type { PendingApproval } from "../lib/types";
import { Icon } from "./Icon";
import { LiveTurn, TranscriptTurn } from "./TranscriptTurn";

type Tab = "detail" | "tools" | "transcript";

export function Inspector({
	sel,
	mission,
	pending,
	onClose,
	onResume,
}: {
	sel: string | null;
	mission: MissionState;
	pending: Record<string, PendingApproval>;
	onClose: () => void;
	onResume: (taskId: string, option: string) => void;
}) {
	const [tab, setTab] = useState<Tab>("detail");
	const streamRef = useRef<HTMLDivElement>(null);
	const task: MissionTask | undefined = sel ? mission.tasks[sel] : undefined;
	const role = task?.role ?? "";
	const agent = mission.agents[role];
	const rawAgent = useStore((s) => (role ? s.agents.get(role) : undefined));

	useEffect(() => {
		setTab("detail");
	}, [sel]);

	useEffect(() => {
		if (tab === "transcript" && streamRef.current) {
			streamRef.current.scrollTop = streamRef.current.scrollHeight;
		}
	}, [tab, agent?.transcript.length, agent?.streamBuffer]);

	if (!task) return <aside className="inspector" aria-hidden="true" />;

	const open = !!sel;
	const info = roleInfo(role);
	const isGate = task.status === "gate";
	const approval = pending[task.id];
	const options = approval?.options ?? [];
	const unblocks = mission.taskList.filter((x) => x.deps.includes(task.id));
	const liveTools = rawAgent?.activeTools ?? [];

	return (
		<aside
			className={`inspector${open ? " show" : ""}`}
			data-s={task.status}
			style={{ "--sc": statColor(task.status) } as React.CSSProperties}
		>
			<div className="insp-head">
				<div className="row">
					<span className="insp-glyph">{info.glyph}</span>
					<div className="insp-title">
						<h3>{task.label}</h3>
						<div className="sub">
							{role} · {task.id}
							{info.desc ? ` · ${info.desc}` : ""}
						</div>
					</div>
					<span
						className="runpill"
						data-s={task.status === "running" ? "running" : task.status === "gate" ? "gated" : task.status}
						style={{ "--sc": statColor(task.status) } as React.CSSProperties}
					>
						<i className="dot" />
						{STAT_LABEL[task.status]}
					</span>
					<button type="button" className="iconbtn" onClick={onClose} aria-label="close">
						<Icon name="x" />
					</button>
				</div>
				<div className="insp-tabs">
					{(
						[
							["detail", "detail"],
							["tools", `tools (${liveTools.length})`],
							["transcript", "transcript"],
						] as [Tab, string][]
					).map(([id, lbl]) => (
						<button
							type="button"
							key={id}
							className={`insp-tab${tab === id ? " on" : ""}`}
							onClick={() => setTab(id)}
						>
							{lbl}
						</button>
					))}
				</div>
			</div>

			{tab === "transcript" ? (
				<div className="insp-stream" ref={streamRef}>
					{agent && (agent.transcript.length > 0 || agent.live) ? (
						<>
							{agent.transcript.map((entry, i) => (
								<TranscriptTurn key={i} entry={entry} role={role} />
							))}
							{agent.live && rawAgent && (
								<LiveTurn
									role={role}
									thinkingBuffer={rawAgent.thinkingBuffer}
									streamBuffer={rawAgent.streamBuffer}
									activeTools={rawAgent.activeTools}
								/>
							)}
						</>
					) : (
						<div className="av-empty">
							<span className="term think">{role} hasn't produced any output yet.</span>
						</div>
					)}
				</div>
			) : (
				<div className="insp-body">
					{tab === "tools" && (
						<div>
							{liveTools.length > 0 ? (
								liveTools.map((t) => (
									<div
										className="toolrow"
										key={t.toolCallId}
										style={
											{
												"--sc":
													t.status === "done"
														? "var(--ok)"
														: t.status === "error"
															? "var(--err)"
															: "var(--accent)",
											} as React.CSSProperties
										}
									>
										<span className="ti">
											<Icon
												name={t.status === "running" ? "cpu" : t.status === "done" ? "check" : "alert"}
												size={14}
											/>
										</span>
										<span className="tn">{t.toolName}</span>
										<span className="ts">{t.status}</span>
									</div>
								))
							) : (
								<span className="t-caption">no active tool calls — see the transcript for history</span>
							)}
						</div>
					)}

					{tab === "detail" && (
						<div>
							<div className="t-eyebrow section-eye" style={{ marginTop: 0 }}>
								Task detail
							</div>
							<dl className="kv">
								<dt>task id</dt>
								<dd>{task.id}</dd>
								<dt>status</dt>
								<dd>{STAT_LABEL[task.status]}</dd>
								{task.retries > 0 && (
									<>
										<dt>retries</dt>
										<dd>{task.retries}</dd>
									</>
								)}
								{task.gate && (
									<>
										<dt>gate</dt>
										<dd>human approval required</dd>
									</>
								)}
								{task.advisor && (
									<>
										<dt>kind</dt>
										<dd>advisor (non-blocking)</dd>
									</>
								)}
							</dl>

							{task.advisor && (
								<>
									<div className="t-eyebrow section-eye">Advisory note</div>
									<div className="term">
										<span className="think">
											non-blocking reviewer. Findings are surfaced to the lead but do not stop the run unless
											you reject the gate.
										</span>
									</div>
								</>
							)}

							<div className="t-eyebrow section-eye">Depends on</div>
							<div>
								{task.deps.length > 0 ? (
									task.deps.map((d) => {
										const dep = mission.tasks[d];
										return (
											<span
												className="deppill"
												key={d}
												style={{ "--sc": statColor(dep?.status ?? "idle") } as React.CSSProperties}
											>
												<i className="dot" />
												{dep?.label ?? d}
											</span>
										);
									})
								) : (
									<span className="t-caption">no dependencies — root task</span>
								)}
							</div>
							<div className="t-eyebrow section-eye">Unblocks</div>
							<div>
								{unblocks.length > 0 ? (
									unblocks.map((x) => (
										<span
											className="deppill"
											key={x.id}
											style={{ "--sc": statColor(x.status) } as React.CSSProperties}
										>
											<i className="dot" />
											{x.label}
										</span>
									))
								) : (
									<span className="t-caption">terminal task</span>
								)}
							</div>

							{agent && (
								<>
									<div className="t-eyebrow section-eye">Agent detail</div>
									<div
										className="insp-agent"
										data-s={agent.status}
										style={{ "--sc": statColor(agent.status) } as React.CSSProperties}
									>
										<span className="ia-glyph">{info.glyph}</span>
										<div className="ia-id">
											<span className="ia-name">{role}</span>
											<span className="ia-desc">{info.desc}</span>
										</div>
										<span className="ia-stat">
											<i className="dot" />
											{STAT_LABEL[agent.status]}
										</span>
									</div>
									<dl className="kv">
										<dt>tokens</dt>
										<dd>{agent.tokens.toLocaleString()}</dd>
										{agent.cost > 0 && (
											<>
												<dt>cost</dt>
												<dd>${agent.cost.toFixed(4)}</dd>
											</>
										)}
										<dt>on task</dt>
										<dd>{agent.taskId ? (mission.tasks[agent.taskId]?.label ?? agent.taskId) : "idle"}</dd>
									</dl>
									<div className="t-eyebrow section-eye">Activity</div>
									<div className="term">
										{agent.line || "idle — no active stage"}
										{isLive(agent.status) && <span className="caret">▍</span>}
									</div>
								</>
							)}

							<button type="button" className="insp-jump" onClick={() => setTab("transcript")}>
								<Icon name="terminal" size={13} />
								view full transcript
							</button>
						</div>
					)}
				</div>
			)}

			{isGate && (
				<div className="gate-actions">
					{approval?.question && <div className="gate-q">{approval.question}</div>}
					{options.length > 0 ? (
						options.map((opt, i) => (
							<button
								type="button"
								key={opt}
								className={`btn${i === 0 ? " primary" : ""}`}
								style={{ flex: 1 }}
								onClick={() => onResume(task.id, opt)}
							>
								{i === 0 && <Icon name="check" />}
								{opt}
							</button>
						))
					) : (
						<>
							<button
								type="button"
								className="btn primary"
								style={{ flex: 1 }}
								onClick={() => onResume(task.id, "approve")}
							>
								<Icon name="check" />
								approve & continue
							</button>
							<button type="button" className="btn danger" onClick={() => onResume(task.id, "reject")}>
								<Icon name="x" />
								reject
							</button>
						</>
					)}
				</div>
			)}
		</aside>
	);
}
