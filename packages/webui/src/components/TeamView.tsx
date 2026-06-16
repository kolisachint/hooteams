/** Team view — read-only roster of the agents on this run. The live SSE stream
 *  carries no static config (model/prompt/tools), so this surface reflects what
 *  the team is actually doing: role, status, current task, tokens, tools used. */
import { useMemo, useState } from "react";
import type { MissionState } from "../lib/mission";
import { roleColor, roleInfo, STAT_LABEL, statColor } from "../lib/roles";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";

export function TeamView({ mission }: { mission: MissionState }) {
	const [mode, setMode] = useState<"cards" | "json">("cards");
	const agents = useStore((s) => s.agents);

	// Distinct tool names each role has invoked (from live + completed turns).
	const toolsByRole = useMemo(() => {
		const out: Record<string, string[]> = {};
		for (const [role, agent] of agents) {
			const names = new Set<string>();
			for (const t of agent.activeTools) names.add(t.toolName);
			for (const entry of agent.transcript) {
				if (entry.kind === "turn") for (const t of entry.tools) names.add(t.toolName);
			}
			out[role] = [...names];
		}
		return out;
	}, [agents]);

	const roster = mission.roles.map((role) => mission.agents[role]!).filter(Boolean);
	const activeCount = roster.filter((a) => a.live).length;

	const json = JSON.stringify(
		{
			runId: mission.run.runId,
			status: mission.run.status,
			roles: roster.map((a) => ({
				role: a.role,
				status: a.status,
				onTask: a.taskId,
				tokens: a.tokens,
				tools: toolsByRole[a.role] ?? [],
			})),
		},
		null,
		2,
	);

	return (
		<div className="view-wrap">
			<header className="view-head">
				<div className="vh-title">
					<h1>
						<Icon name="users" size={18} />
						Team
					</h1>
					<span className="vh-sub">
						{roster.length} roles · {activeCount} active · run {mission.run.runId}
					</span>
				</div>
				<div className="spacer" />
				<div className="vh-actions">
					<span className="tagpill">
						<Icon name="eye" size={11} />
						read-only
					</span>
					<div className="seg">
						<button type="button" className={mode === "cards" ? "on" : ""} onClick={() => setMode("cards")}>
							<Icon name="users" size={13} />
							roles
						</button>
						<button type="button" className={mode === "json" ? "on" : ""} onClick={() => setMode("json")}>
							<Icon name="file" size={13} />
							roster
						</button>
					</div>
				</div>
			</header>

			<div className="view-body">
				{roster.length === 0 ? (
					<div className="team-empty">No agents have joined this run yet.</div>
				) : mode === "cards" ? (
					<div className="team-wrap">
						<div className="team-settings">
							<div className="ts-cell">
								<span className="eyebrow">roles</span>
								<b className="ts-stat">{roster.length}</b>
								<span className="ts-hint">agents on this run</span>
							</div>
							<div className="ts-cell">
								<span className="eyebrow">active now</span>
								<b className="ts-stat">{activeCount}</b>
								<span className="ts-hint">currently working</span>
							</div>
							<div className="ts-cell">
								<span className="eyebrow">tokens</span>
								<b className="ts-stat">{(mission.run.tokens / 1000).toFixed(1)}k</b>
								<span className="ts-hint">across the team</span>
							</div>
							<div className="ts-cell grow">
								<span className="eyebrow">goal</span>
								<code className="ts-stat-code">{mission.run.goal ?? "—"}</code>
								<span className="ts-hint">what the team is shipping</span>
							</div>
						</div>

						<div className="team-grid">
							{roster.map((a) => {
								const info = roleInfo(a.role);
								const tools = toolsByRole[a.role] ?? [];
								return (
									<div
										key={a.role}
										className="role-card"
										style={{ "--sc": roleColor(a.role) } as React.CSSProperties}
									>
										<div className="rc-head">
											<span className="rc-glyph">{info.glyph}</span>
											<div className="rc-id">
												<span className="rc-name">{a.role}</span>
												<span className="rc-desc">{info.desc}</span>
											</div>
											<span
												className="runpill"
												data-s={a.status === "running" ? "running" : a.status}
												style={{ "--sc": statColor(a.status) } as React.CSSProperties}
											>
												<i className="dot" />
												{STAT_LABEL[a.status]}
											</span>
										</div>

										<div className="rc-row">
											<span className="rl">on task</span>
											<code className="rc-val">
												{a.taskId ? (mission.tasks[a.taskId]?.label ?? a.taskId) : "idle"}
											</code>
										</div>
										<div className="rc-row">
											<span className="rl">tokens</span>
											<code className="rc-val">{a.tokens.toLocaleString()}</code>
										</div>

										<div className="rc-tools">
											<span className="eyebrow">tools · {tools.length}</span>
											<div className="tool-chips">
												{tools.length > 0 ? (
													tools.map((tn) => (
														<span key={tn} className="tchip on">
															{tn}
														</span>
													))
												) : (
													<span className="ts-hint">none used yet</span>
												)}
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</div>
				) : (
					<div className="json-wrap">
						<div className="json-head">
							<span className="eyebrow">team roster</span>
							<span className="tagpill">read-only</span>
						</div>
						<pre className="json-view">{json}</pre>
					</div>
				)}
			</div>
		</div>
	);
}
