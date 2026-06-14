import { useEffect, useRef } from "react";

interface TokenStreamProps {
	text: string;
	streaming: boolean;
}

/** Live output text: auto-scrolls while streaming, cyan `_` cursor at the tip. */
export function TokenStream({ text, streaming }: TokenStreamProps) {
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [text]);

	if (!text && !streaming) return null;

	return (
		<div
			ref={scrollRef}
			className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words py-1 text-[13px] leading-relaxed"
			style={{ color: "var(--text)" }}
		>
			<span className={streaming ? "cursor" : undefined}>{text}</span>
		</div>
	);
}
