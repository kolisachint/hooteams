import { useState } from "react";

interface ThinkingBlockProps {
	text: string;
	live: boolean;
}

/** Collapsible reasoning trace — dimmed italic, collapsed by default. */
export function ThinkingBlock({ text, live }: ThinkingBlockProps) {
	const [open, setOpen] = useState(false);

	if (!text) return null;

	return (
		<div className="py-0.5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				className="flex items-center gap-1.5 text-[11px] tracking-wide"
				style={{ color: "var(--text-faint)" }}
			>
				<span style={{ color: "var(--cyan)" }}>{open ? "▾" : "▸"}</span>
				<span className={live ? "italic" : undefined}>
					thinking{live ? "…" : ""} <span className="opacity-60">({text.length} chars)</span>
				</span>
			</button>
			{open && (
				<div
					className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l pl-3 text-[12px] italic"
					style={{ color: "var(--text-faint)", borderColor: "var(--line)" }}
				>
					{text}
				</div>
			)}
		</div>
	);
}
