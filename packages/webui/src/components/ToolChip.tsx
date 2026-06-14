import { useState } from "react";
import type { ToolChipState } from "../lib/types";

function preview(value: unknown, max = 400): string {
	if (value === undefined) return "";
	const text = JSON.stringify(value, null, 2) ?? "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Tool lifecycle pill: amber spinner while running, ✓ / ✗ when settled. Click for detail. */
export function ToolChip({ tool }: { tool: ToolChipState }) {
	const [open, setOpen] = useState(false);

	const icon =
		tool.status === "running" ? (
			<span className="chip-spinner" />
		) : tool.status === "done" ? (
			<span style={{ color: "var(--green)" }}>✓</span>
		) : (
			<span style={{ color: "var(--red)" }}>✗</span>
		);

	const borderColor =
		tool.status === "running" ? "var(--amber)" : tool.status === "done" ? "var(--line-bright)" : "var(--red)";

	return (
		<div className="inline-block align-top">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors"
				style={{ borderColor, color: "var(--text-dim)", background: "var(--panel-raised)" }}
			>
				{icon}
				<span>{tool.toolName}</span>
			</button>
			{open && (
				<pre
					className="mt-1 max-h-44 max-w-full overflow-auto rounded border p-2 text-[11px] leading-snug"
					style={{ borderColor: "var(--line)", background: "var(--bg)", color: "var(--text-faint)" }}
				>
					{[
						tool.args !== undefined ? `args: ${preview(tool.args)}` : "",
						tool.partialResult !== undefined && tool.status === "running"
							? `partial: ${preview(tool.partialResult)}`
							: "",
						tool.result !== undefined ? `result: ${preview(tool.result)}` : "",
					]
						.filter(Boolean)
						.join("\n") || "no detail yet"}
				</pre>
			)}
		</div>
	);
}
