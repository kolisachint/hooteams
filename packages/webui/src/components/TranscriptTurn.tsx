/** Renders one transcript entry (a completed turn or a nudge) as agent-log
 *  lines: reasoning, tool calls, and assistant prose. */

import type { ToolChipState, TranscriptEntry } from "../lib/types";
import { Icon } from "./Icon";

function summarize(value: unknown, max: number): string {
	if (value == null) return "";
	if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
	try {
		const s = JSON.stringify(value);
		return s.length > max ? `${s.slice(0, max)}…` : s;
	} catch {
		return String(value);
	}
}

function ToolCall({ tool }: { tool: ToolChipState }) {
	const arg = summarize(tool.args, 80);
	const result = tool.status === "error" ? summarize(tool.result, 120) : summarize(tool.result, 120);
	return (
		<div className={`tt tt-tool${tool.status === "error" ? " warn" : ""}`}>
			<span className="tt-gut">
				<Icon name="wrench" size={12} />
			</span>
			<span className="tt-body">
				<div className="tool-call">
					<b>{tool.toolName}</b>
					{arg && <code>{arg}</code>}
				</div>
				{tool.status !== "running" && result && <div className="tool-result">→ {result}</div>}
			</span>
		</div>
	);
}

export function TranscriptTurn({ entry, role }: { entry: TranscriptEntry; role: string }) {
	if (entry.kind === "nudge") {
		return (
			<div className="tt tt-nudge">
				<span className="tt-gut">you ❯</span>
				<span className="tt-body">{entry.text}</span>
			</div>
		);
	}
	return (
		<>
			{entry.thinking.trim() && (
				<div className="tt tt-think">
					<span className="tt-gut">·</span>
					<span className="tt-body think">{entry.thinking}</span>
				</div>
			)}
			{entry.tools.map((tool) => (
				<ToolCall key={tool.toolCallId} tool={tool} />
			))}
			{entry.text.trim() && (
				<div className={`tt tt-msg${entry.error ? " warn" : ""}`}>
					<span className="tt-gut">{role} ❯</span>
					<span className="tt-body">{entry.text}</span>
				</div>
			)}
			{entry.error && (
				<div className="tt tt-msg warn">
					<span className="tt-gut">{role} ❯</span>
					<span className="tt-body">⚠ {entry.error}</span>
				</div>
			)}
		</>
	);
}

/** The in-flight turn, drawn from the live buffers. */
export function LiveTurn({
	role,
	thinkingBuffer,
	streamBuffer,
	activeTools,
}: {
	role: string;
	thinkingBuffer: string;
	streamBuffer: string;
	activeTools: ToolChipState[];
}) {
	return (
		<>
			{thinkingBuffer.trim() && (
				<div className="tt tt-think">
					<span className="tt-gut">·</span>
					<span className="tt-body think">{thinkingBuffer}</span>
				</div>
			)}
			{activeTools.map((tool) => (
				<ToolCall key={tool.toolCallId} tool={tool} />
			))}
			<div className="tt tt-msg">
				<span className="tt-gut">{role} ❯</span>
				<span className="tt-body">
					{streamBuffer}
					<span className="caret">▍</span>
				</span>
			</div>
		</>
	);
}
