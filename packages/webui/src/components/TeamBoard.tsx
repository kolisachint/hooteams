import { useStore } from "../lib/store";
import { AgentCard } from "./AgentCard";

function EmptyState() {
	return (
		<div className="flex flex-col items-center gap-4 py-32" style={{ color: "var(--text-faint)" }}>
			<svg width="120" height="60" viewBox="0 0 120 60" fill="none" aria-hidden="true">
				<circle cx="20" cy="30" r="4" fill="var(--cyan)" className="node-pulse" />
				<circle
					cx="60"
					cy="14"
					r="4"
					fill="var(--cyan)"
					className="node-pulse"
					style={{ animationDelay: "0.4s" }}
				/>
				<circle
					cx="60"
					cy="46"
					r="4"
					fill="var(--cyan)"
					className="node-pulse"
					style={{ animationDelay: "0.8s" }}
				/>
				<circle
					cx="100"
					cy="30"
					r="4"
					fill="var(--cyan)"
					className="node-pulse"
					style={{ animationDelay: "1.2s" }}
				/>
				<path d="M24 28 56 16M24 32 56 44M64 16 96 28M64 44 96 32" stroke="var(--line-bright)" strokeWidth="1" />
			</svg>
			<p className="text-[13px]">waiting for agents…</p>
			<p className="text-[11px] opacity-60">start a team: hooteams start --config hooteams.config.json</p>
		</div>
	);
}

/** Grid of agent panes, one per role seen on the stream. */
export function TeamBoard() {
	const agents = useStore((state) => state.agents);

	if (agents.size === 0) return <EmptyState />;

	return (
		<div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))" }}>
			{[...agents.values()].map((agent, index) => (
				<AgentCard key={agent.role} agent={agent} index={index} />
			))}
		</div>
	);
}
