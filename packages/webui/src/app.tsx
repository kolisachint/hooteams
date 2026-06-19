import { useEffect, useMemo, useRef, useState } from "react";
import { ConfigView } from "./components/ConfigView";
import { Icon } from "./components/Icon";
import { Inspector } from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import { type StageLayout, StagesView } from "./components/StagesView";
import { TeamView } from "./components/TeamView";
import { buildMission } from "./lib/mission";
import { fetchSession, listSessions } from "./lib/session";
import { useStore } from "./lib/store";
import { connect, disconnect, HOOTEAMS_HOST, resumeTask } from "./lib/stream";

type View = "taskgraph" | "config" | "team";

const LS = {
	view: "ht.view",
	layout: "ht.layout",
	theme: "ht.theme",
	minimap: "ht.minimap",
};

function readBool(key: string, fallback: boolean): boolean {
	const v = localStorage.getItem(key);
	return v == null ? fallback : v === "1";
}

// ── Top bar ───────────────────────────────────────────────────────────────────
function TopBar({
	view,
	setView,
	runStatus,
	gatePending,
	theme,
	onTheme,
	minimap,
	setMinimap,
	onToggleNav,
}: {
	view: View;
	setView: (v: View) => void;
	runStatus: string;
	gatePending: string | null;
	theme: string;
	onTheme: () => void;
	minimap: boolean;
	setMinimap: (v: boolean) => void;
	onToggleNav: () => void;
}) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	return (
		<header className="topbar">
			<button type="button" className="tb-set icon nav-toggle" onClick={onToggleNav} title="toggle sidebar">
				<Icon name="menu" size={15} />
			</button>
			<div className="tb-brand">
				<span className="tb-mark">h</span>
				<span className="tb-word">
					hoo<b>teams</b>
				</span>
			</div>
			<button
				type="button"
				className={`tb-view${view === "taskgraph" ? " on" : ""}`}
				onClick={() => setView("taskgraph")}
				title="task graph"
			>
				<Icon name="graph" size={15} />
				TaskGraph
				{view === "taskgraph" && runStatus === "running" && <span className="tb-live" />}
				{view === "taskgraph" && gatePending && <span className="tb-badge">1</span>}
			</button>
			<button
				type="button"
				className={`tb-view${view === "config" ? " on" : ""}`}
				onClick={() => setView("config")}
				title="run config"
			>
				<Icon name="file" size={15} />
				Config
			</button>
			<div className="spacer" />
			<div className="tb-settings">
				<button
					type="button"
					className={`tb-set${view === "team" ? " on" : ""}`}
					onClick={() => setView(view === "team" ? "taskgraph" : "team")}
					title="team config"
				>
					<Icon name="users" size={15} />
					team
				</button>
				<button type="button" className="tb-set icon" onClick={onTheme} title="toggle theme">
					<Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
				</button>
				<button
					type="button"
					className={`tb-set icon${settingsOpen ? " on" : ""}`}
					onClick={() => setSettingsOpen((o) => !o)}
					title="settings"
				>
					<Icon name="sliders" size={15} />
				</button>
				{settingsOpen && (
					<>
						{/* click-away */}
						<div
							style={{ position: "fixed", inset: 0, zIndex: 65 }}
							onClick={() => setSettingsOpen(false)}
							aria-hidden="true"
						/>
						<div className="settings-pop">
							<span className="sp-sect">TaskGraph</span>
							<div className="sp-row">
								<span>Run map</span>
								<button
									type="button"
									className="sp-toggle"
									data-on={minimap ? "1" : "0"}
									aria-pressed={minimap}
									onClick={() => setMinimap(!minimap)}
								>
									<i />
								</button>
							</div>
							<span className="sp-sect">Appearance</span>
							<div className="sp-row">
								<span>Dark mode</span>
								<button
									type="button"
									className="sp-toggle"
									data-on={theme === "dark" ? "1" : "0"}
									aria-pressed={theme === "dark"}
									onClick={onTheme}
								>
									<i />
								</button>
							</div>
						</div>
					</>
				)}
			</div>
		</header>
	);
}

// ── App ─────────────────────────────────────────────────────────────────────
export function App() {
	const runInfo = useStore((s) => s.runInfo);
	const agents = useStore((s) => s.agents);
	const events = useStore((s) => s.events);
	const pending = useStore((s) => s.pending);
	const connection = useStore((s) => s.connection);
	const loadRun = useStore((s) => s.loadRun);

	const [view, setView] = useState<View>(() => (localStorage.getItem(LS.view) === "team" ? "team" : "taskgraph"));
	const [layout, setLayout] = useState<StageLayout>(() => {
		const v = localStorage.getItem(LS.layout);
		return v === "timeline" || v === "feed" ? v : "graph";
	});
	const [theme, setTheme] = useState<string>(() => localStorage.getItem(LS.theme) ?? "light");
	const [minimap, setMinimap] = useState<boolean>(() => readBool(LS.minimap, true));
	const [sel, setSel] = useState<string | null>(null);
	const [feedFilter, setFeedFilter] = useState("all");
	const [now, setNow] = useState(() => Date.now());
	const [loadError, setLoadError] = useState<string | null>(null);
	const [navOpen, setNavOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth > 860 : true));
	const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
		new URLSearchParams(window.location.search).get("runId"),
	);
	const [logPath, setLogPath] = useState<string | null>(null);

	const sessionMode = useRef(false);
	// runId we've already backfilled from disk, so a settled live run is reloaded once.
	const backfilledRunId = useRef<string | null>(null);

	// Connect to the live stream, or load a session for replay (selectedRunId,
	// driven by the sidebar's run list — kept in sync with ?runId= below).
	useEffect(() => {
		let cancelled = false;
		setLoadError(null);
		if (selectedRunId) {
			sessionMode.current = true;
			fetchSession(selectedRunId, HOOTEAMS_HOST)
				.then((info) => {
					if (cancelled) return;
					if (info) loadRun(info);
					else setLoadError(`Session not found: ${selectedRunId}`);
				})
				.catch((err) => {
					if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load session");
				});
			return () => {
				cancelled = true;
			};
		}
		sessionMode.current = false;
		connect();
		return () => {
			cancelled = true;
			disconnect();
		};
	}, [selectedRunId, loadRun]);

	// Keep ?runId= in sync without adding a history entry per switch.
	useEffect(() => {
		const url = new URL(window.location.href);
		if (selectedRunId) url.searchParams.set("runId", selectedRunId);
		else url.searchParams.delete("runId");
		window.history.replaceState(null, "", url);
	}, [selectedRunId]);

	// Once the *live* run settles, reload its task graph from the persisted log so
	// the view is complete and reload-proof (the SSE replay buffer is capped and
	// in-memory). keepEvents preserves the activity feed gathered while streaming.
	const liveSettled = !selectedRunId && (runInfo?.status === "done" || runInfo?.status === "error");
	useEffect(() => {
		if (!liveSettled || !runInfo || backfilledRunId.current === runInfo.runId) return;
		backfilledRunId.current = runInfo.runId;
		let cancelled = false;
		fetchSession(runInfo.runId, HOOTEAMS_HOST)
			.then((info) => {
				if (!cancelled && info) loadRun(info, { keepEvents: true });
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [liveSettled, runInfo, loadRun]);

	// Resolve the on-disk log path for whichever finished run we're viewing — drives
	// the "viewing from log" banner. selectedRunId = explicit replay; liveSettled =
	// the active run has ended.
	const logRunId = selectedRunId ?? (liveSettled ? (runInfo?.runId ?? null) : null);
	useEffect(() => {
		if (!logRunId) {
			setLogPath(null);
			return;
		}
		let cancelled = false;
		listSessions(HOOTEAMS_HOST).then((sessions) => {
			if (!cancelled) setLogPath(sessions.find((s) => s.runId === logRunId)?.path ?? null);
		});
		return () => {
			cancelled = true;
		};
	}, [logRunId]);

	// 1s clock for the elapsed counter / live timeline.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => localStorage.setItem(LS.view, view), [view]);
	useEffect(() => localStorage.setItem(LS.layout, layout), [layout]);
	useEffect(() => localStorage.setItem(LS.minimap, minimap ? "1" : "0"), [minimap]);
	useEffect(() => {
		localStorage.setItem(LS.theme, theme);
		document.documentElement.classList.toggle("dark", theme === "dark");
		document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);

	const mission = useMemo(() => buildMission(runInfo, agents, pending), [runInfo, agents, pending]);
	const elapsedSec = mission.run.startedAt ? ((mission.run.endedAt ?? now) - mission.run.startedAt) / 1000 : 0;

	const onResume = (taskId: string, option: string) => {
		setSel(null);
		resumeTask(taskId, option).catch(() => {
			/* the next snapshot will reflect the real gate state */
		});
	};

	return (
		<div className={`app-shell${navOpen ? " nav-open" : " nav-collapsed"}`}>
			<Sidebar onCollapse={() => setNavOpen(false)} selectedRunId={selectedRunId} onSelectRun={setSelectedRunId} />
			<div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />
			<div className="shell">
				<TopBar
					view={view}
					setView={setView}
					runStatus={mission.run.status}
					gatePending={mission.run.gatePending}
					theme={theme}
					onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
					minimap={minimap}
					setMinimap={setMinimap}
					onToggleNav={() => setNavOpen((v) => !v)}
				/>
				<div className="workspace">
					{view === "team" ? (
						<TeamView mission={mission} />
					) : view === "config" ? (
						<ConfigView logPath={logPath} />
					) : loadError ? (
						<div className="app stages">
							<div className="stage-empty">
								<span className="se-mark">
									<Icon name="alert" size={22} />
								</span>
								<div className="se-title">Couldn't load the run</div>
								<div className="se-sub">{loadError}</div>
							</div>
						</div>
					) : (
						<StagesView
							mission={mission}
							connection={sessionMode.current ? "live" : connection}
							logPath={logPath}
							elapsedSec={elapsedSec}
							view={layout}
							setView={setLayout}
							minimap={minimap}
							sel={sel}
							onSelect={setSel}
							events={events}
							feedFilter={feedFilter}
							setFeedFilter={setFeedFilter}
						/>
					)}
				</div>

				<div className={`scrim${sel ? " show" : ""}`} onClick={() => setSel(null)} aria-hidden="true" />
				<Inspector sel={sel} mission={mission} pending={pending} onClose={() => setSel(null)} onResume={onResume} />
			</div>
		</div>
	);
}
