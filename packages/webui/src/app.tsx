import { useEffect, useState } from "react";
import { DagViewer } from "./components/DagViewer";
import { TeamBoard } from "./components/TeamBoard";
import { fetchSession } from "./lib/session";
import { useStore } from "./lib/store";
import { connect, disconnect, HOOTEAMS_HOST, HOOTEAMS_HOST_LABEL } from "./lib/stream";
import type { RunInfo } from "./lib/types";

function ConnectionBadge() {
	const connection = useStore((state) => state.connection);
	const color =
		connection === "live" ? "var(--cyan)" : connection === "reconnecting" ? "var(--amber)" : "var(--text-faint)";
	return (
		<span className="flex items-center gap-1.5 text-[11px]" style={{ color }}>
			<span
				className={`h-1.5 w-1.5 rounded-full ${connection === "live" ? "presence" : ""}`}
				style={{ background: color }}
			/>
			{connection}
			<span style={{ color: "var(--text-faint)" }}>· {HOOTEAMS_HOST_LABEL}</span>
		</span>
	);
}

function RunHeader({ runInfo }: { runInfo: RunInfo }) {
	const taskCount = Object.keys(runInfo.dag).length;
	const doneCount = Object.values(runInfo.dag).filter((n) => n.status === "done").length;
	const errorCount = Object.values(runInfo.dag).filter((n) => n.status === "error").length;

	return (
		<div
			className="rounded p-3 mb-4"
			style={{
				border: "1px solid var(--line)",
				background: "var(--panel)",
				borderRadius: "4px",
			}}
		>
			<div className="flex items-center gap-3">
				<span
					className="text-[10px] uppercase font-semibold"
					style={{ color: "var(--text-faint)", letterSpacing: "0.12em" }}
				>
					Run
				</span>
				<span className="text-[12px] font-mono" style={{ color: "var(--text)" }}>
					{runInfo.runId}
				</span>
				<span className="ml-auto text-[11px]" style={{ color: "var(--text-faint)" }}>
					{doneCount}/{taskCount} done
					{errorCount > 0 && <span style={{ color: "#D9788A" }}> · {errorCount} error</span>}
				</span>
			</div>
			{runInfo.goal && (
				<p className="text-[12px] mt-2 leading-relaxed" style={{ color: "var(--text-dim)" }}>
					{runInfo.goal}
				</p>
			)}
		</div>
	);
}

export function App() {
	const [runInfo, setRunInfo] = useState<RunInfo | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const runId = params.get("runId");

		if (runId) {
			// Load session from server
			setLoading(true);
			setError(null);
			fetchSession(runId, HOOTEAMS_HOST)
				.then((info) => {
					if (info) {
						setRunInfo(info);
					} else {
						setError(`Session not found: ${runId}`);
					}
				})
				.catch((err) => {
					setError(err instanceof Error ? err.message : "Failed to load session");
				})
				.finally(() => {
					setLoading(false);
				});
		} else {
			// Connect to live stream
			connect();
		}
		return disconnect;
	}, []);

	// If we have a runId, show the DAG viewer
	const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
	const hasRunId = params?.has("runId");

	if (hasRunId) {
		return (
			<div className="mx-auto max-w-[1200px] px-6 py-5">
				<header className="mb-6 flex items-baseline gap-2">
					<h1 className="text-[15px] font-semibold tracking-wide" style={{ color: "var(--text)" }}>
						hoo<span style={{ color: "var(--cyan)" }}>◆</span>teams
					</h1>
					<span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
						team mission control
					</span>
					<div className="ml-auto">
						<a href="/" className="text-[11px] hover:underline" style={{ color: "var(--text-faint)" }}>
							← live stream
						</a>
					</div>
				</header>

				{loading && (
					<div className="flex items-center justify-center py-32" style={{ color: "var(--text-faint)" }}>
						<div className="chip-spinner mr-2" />
						<span className="text-[13px]">loading session…</span>
					</div>
				)}

				{error && (
					<div
						className="rounded p-4 text-center"
						style={{
							border: "1px solid #D9788A",
							background: "rgba(217, 120, 138, 0.08)",
							color: "#D9788A",
							borderRadius: "4px",
						}}
					>
						{error}
					</div>
				)}

				{runInfo && (
					<>
						<RunHeader runInfo={runInfo} />
						<DagViewer runInfo={runInfo} />
					</>
				)}
			</div>
		);
	}

	// Default: live stream view
	return (
		<div className="mx-auto max-w-[1600px] px-6 py-5">
			<header className="mb-6 flex items-baseline gap-2">
				<h1 className="text-[15px] font-semibold tracking-wide" style={{ color: "var(--text)" }}>
					hoo<span style={{ color: "var(--cyan)" }}>◆</span>teams
				</h1>
				<span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
					team mission control
				</span>
				<div className="ml-auto">
					<ConnectionBadge />
				</div>
			</header>
			<TeamBoard />
		</div>
	);
}
