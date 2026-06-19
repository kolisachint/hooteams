/**
 * Config view — the static setup the live SSE stream never carries: the run's
 * task graph (as read-only YAML) and the team config (models, providers, system
 * prompts, concurrency).
 *
 * Source mirrors the "viewing from log" model: a finished/replayed run reads its
 * persisted `team_config` snapshot from the session log (so you see what it
 * actually ran with); a live run falls back to GET /config (the current server
 * setup). The "from log" banner + badge make the source explicit.
 */
import { useEffect, useMemo, useState } from "react";
import { roleColor } from "../lib/roles";
import { useStore } from "../lib/store";
import { fetchConfig, HOOTEAMS_HOST } from "../lib/stream";
import type { RunInfo, TeamConfig } from "../lib/types";
import { Icon } from "./Icon";

/** The run's task graph as a read-only YAML-ish config block. */
function taskGraphYaml(runInfo: RunInfo | null, maxConcurrent?: number): string {
	if (!runInfo) return "# no run loaded";
	const lines: string[] = [];
	if (runInfo.goal) lines.push(`goal: ${runInfo.goal}`);
	if (maxConcurrent != null) lines.push(`maxConcurrent: ${maxConcurrent}`);
	lines.push("tasks:");
	for (const node of Object.values(runInfo.dag)) {
		lines.push(`  - id: ${node.id}`);
		lines.push(`    role: ${node.role}`);
		lines.push(`    deps: [${node.deps.join(", ")}]`);
		if (node.gate) lines.push("    gate: true");
		if (node.advisor) lines.push("    advisor: true");
		if (node.retries != null) lines.push(`    retries: ${node.retries}`);
	}
	return lines.join("\n");
}

function yamlLineClass(line: string): string {
	if (/^\s*#/.test(line)) return "cfg-comment";
	if (/^\s*-?\s*[\w.-]+:/.test(line)) return "cfg-key";
	return "";
}

function RoleCard({ role }: { role: TeamConfig["roles"][number] }) {
	const [open, setOpen] = useState(false);
	const prompt = role.systemPrompt ?? "";
	const long = prompt.length > 180;
	return (
		<div className="cfg-role" style={{ "--sc": roleColor(role.role) } as React.CSSProperties}>
			<div className="cfg-role-head">
				<span className="cfg-role-name">{role.role}</span>
				{role.model && <span className="cfg-role-model">{role.model}</span>}
			</div>
			<div className="cfg-role-meta">
				{role.provider && <span>{role.provider}</span>}
				{role.thinkingLevel && <span>thinking: {role.thinkingLevel}</span>}
				{role.category && <span>{role.category}</span>}
				{role.defaultTools && <span>coding tools</span>}
			</div>
			{prompt && (
				<>
					<div className="cfg-role-prompt">{open || !long ? prompt : `${prompt.slice(0, 180)}…`}</div>
					{long && (
						<button type="button" className="cfg-role-toggle" onClick={() => setOpen((o) => !o)}>
							{open ? "show less" : "show full prompt"}
						</button>
					)}
				</>
			)}
		</div>
	);
}

export function ConfigView({ logPath }: { logPath?: string | null }) {
	const runInfo = useStore((s) => s.runInfo);
	const [liveConfig, setLiveConfig] = useState<TeamConfig | null>(null);

	// Logged config is authoritative for a finished/replayed run; only fetch the
	// current server config when the run carries none (i.e. it's live).
	const loggedConfig = runInfo?.teamConfig ?? null;
	useEffect(() => {
		if (loggedConfig) return;
		let cancelled = false;
		fetchConfig(HOOTEAMS_HOST).then((cfg) => {
			if (!cancelled) setLiveConfig(cfg);
		});
		return () => {
			cancelled = true;
		};
	}, [loggedConfig]);

	const config = loggedConfig ?? liveConfig;
	const fromLog = !!loggedConfig;
	const taskCount = runInfo ? Object.keys(runInfo.dag).length : 0;
	const yamlLines = useMemo(
		() =>
			taskGraphYaml(runInfo, config?.maxConcurrent)
				.split("\n")
				.map((text, i) => ({ no: i + 1, text })),
		[runInfo, config?.maxConcurrent],
	);

	return (
		<div className="view-wrap">
			<header className="view-head">
				<div className="vh-title">
					<h1>
						<Icon name="file" size={18} />
						Config
					</h1>
					<span className="vh-sub">
						{taskCount} tasks · {config?.roles.length ?? 0} roles · {fromLog ? "from log" : "live"}
					</span>
				</div>
				<div className="spacer" />
				<div className="vh-actions">
					<span className="tagpill">
						<Icon name="eye" size={11} />
						read-only
					</span>
					<span className="conn" data-conn={fromLog ? "log" : "live"}>
						<i className="dot" />
						{fromLog ? "log" : "live"}
					</span>
				</div>
			</header>

			<div className="view-body">
				{fromLog && (
					<div className="tg-banner done">
						<span className="tg-banner-ic">
							<Icon name="info" size={14} />
						</span>
						<span className="tg-banner-text">
							Config from the run's log — what it actually ran with
							{logPath && <span className="tg-banner-path"> · {logPath}</span>}
						</span>
					</div>
				)}

				{!runInfo ? (
					<div className="team-empty">No run loaded yet.</div>
				) : (
					<div className="cfg-grid">
						<div className="cfg-pane">
							<div className="cfg-pane-head">
								<Icon name="file" size={14} />
								<span className="cfg-pane-title">taskgraph</span>
								<span className="tagpill">read-only</span>
								<div className="spacer" />
								<span className="cfg-pane-meta">{runInfo.runId}</span>
							</div>
							<pre className="cfg-code">
								{yamlLines.map((line) => (
									<div className="cfg-line" key={line.no}>
										<span className="cfg-no">{line.no}</span>
										<span className={`cfg-text ${yamlLineClass(line.text)}`}>{line.text || " "}</span>
									</div>
								))}
							</pre>
						</div>

						<div className="cfg-side">
							<div className="cfg-summary">
								<div className="eyebrow">Run</div>
								<div className="cfg-sum-row">
									<span>goal</span>
									<b>{runInfo.goal ?? "—"}</b>
								</div>
								<div className="cfg-sum-row">
									<span>status</span>
									<b>{runInfo.status}</b>
								</div>
								<div className="cfg-sum-row">
									<span>tasks</span>
									<b>{taskCount}</b>
								</div>
								{config?.defaults?.model && (
									<div className="cfg-sum-row">
										<span>default model</span>
										<b>{config.defaults.model}</b>
									</div>
								)}
								{config?.maxConcurrent != null && (
									<div className="cfg-sum-row">
										<span>concurrency</span>
										<b>{config.maxConcurrent}</b>
									</div>
								)}
								{config?.validator && (
									<div className="cfg-sum-row">
										<span>validator</span>
										<b>on</b>
									</div>
								)}
							</div>

							<div className="cfg-team">
								<div className="eyebrow">Team</div>
								{config && config.roles.length > 0 ? (
									config.roles.map((role) => <RoleCard key={role.role} role={role} />)
								) : (
									<div className="cfg-team-empty">
										{config ? "no roles configured" : "team config unavailable"}
									</div>
								)}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
