import type { AgentState } from "../lib/types";
import { SteerInput } from "./SteerInput";
import { ThinkingBlock } from "./ThinkingBlock";
import { TokenStream } from "./TokenStream";
import { ToolChip } from "./ToolChip";

const STATUS_LABEL: Record<AgentState["status"], string> = {
	idle: "idle",
	thinking: "thinking",
	streaming: "streaming",
	tool: "tool",
	done: "done",
	error: "error",
};

/** One terminal pane per agent: header bar, transcript, live buffers, nudge prompt. */
export function AgentCard({ agent, index }: { agent: AgentState; index: number }) {
	const busy = agent.status === "thinking" || agent.status === "streaming" || agent.status === "tool";

	return (
		<section
			className="card-in relative flex flex-col gap-2 overflow-hidden rounded-lg border p-3"
			style={{
				borderColor: "var(--line)",
				background: "var(--panel)",
				animationDelay: `${index * 70}ms`,
			}}
		>
			{/* signal sweep across the top edge whenever an event lands */}
			{agent.lastEventTs > 0 && <span key={agent.lastEventTs} className="sweep" />}

			<header className="flex items-center gap-2">
				<span
					className={`h-1.5 w-1.5 rounded-full ${busy ? "presence" : ""}`}
					style={{
						background: busy ? "var(--cyan)" : agent.status === "error" ? "var(--red)" : "var(--line-bright)",
					}}
				/>
				<h2 className="text-[13px] font-semibold tracking-wide" style={{ color: "var(--text)" }}>
					{agent.role}
				</h2>
				<span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
					{agent.agentId.slice(0, 8)}
				</span>
				<span
					className={`ml-auto rounded-full border px-2 py-px text-[10px] tracking-widest uppercase status-${agent.status}`}
				>
					{STATUS_LABEL[agent.status]}
				</span>
			</header>

			<div className="flex min-h-16 flex-col gap-1">
				{/* completed turns + nudges */}
				{agent.transcript.map((entry, at) =>
					entry.kind === "nudge" ? (
						<div key={at} className="text-[12px]" style={{ color: "var(--cyan)" }}>
							» {entry.text}
						</div>
					) : (
						<div key={at} className="border-b pb-1" style={{ borderColor: "var(--line)" }}>
							<ThinkingBlock text={entry.thinking} live={false} />
							{entry.text && (
								<div
									className="whitespace-pre-wrap break-words text-[13px]"
									style={{ color: "var(--text-dim)" }}
								>
									{entry.text}
								</div>
							)}
							{entry.tools.length > 0 && (
								<div className="mt-1 flex flex-wrap gap-1.5">
									{entry.tools.map((tool) => (
										<ToolChip key={tool.toolCallId} tool={tool} />
									))}
								</div>
							)}
							{entry.error && (
								<div className="text-[12px]" style={{ color: "var(--red)" }}>
									error: {entry.error}
								</div>
							)}
							{entry.usage && (
								<div className="text-[10px]" style={{ color: "var(--text-faint)" }}>
									{entry.usage.input ?? 0} in / {entry.usage.output ?? 0} out
									{entry.usage.cost?.total ? ` · $${entry.usage.cost.total.toFixed(4)}` : ""}
								</div>
							)}
						</div>
					),
				)}

				{/* live turn */}
				<ThinkingBlock text={agent.thinkingBuffer} live={agent.status === "thinking"} />
				<TokenStream text={agent.streamBuffer} streaming={agent.status === "streaming"} />
				{agent.activeTools.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{agent.activeTools.map((tool) => (
							<ToolChip key={tool.toolCallId} tool={tool} />
						))}
					</div>
				)}
			</div>

			<SteerInput role={agent.role} />
		</section>
	);
}
