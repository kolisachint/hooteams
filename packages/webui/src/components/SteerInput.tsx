import { useState } from "react";
import { steer } from "../lib/stream";

/** Terminal-prompt text input: Enter fires POST /steer at this agent. */
export function SteerInput({ role }: { role: string }) {
	const [value, setValue] = useState("");
	const [flash, setFlash] = useState<"sent" | "failed" | null>(null);

	const send = async () => {
		const message = value.trim();
		if (!message) return;
		setValue("");
		try {
			await steer(role, message);
			setFlash("sent");
		} catch {
			setFlash("failed");
		}
		setTimeout(() => setFlash(null), 1500);
	};

	return (
		<div className="flex items-center gap-2 border-t pt-2 text-[12px]" style={{ borderColor: "var(--line)" }}>
			<span style={{ color: "var(--cyan)" }}>nudge&nbsp;&gt;</span>
			<input
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void send();
				}}
				placeholder="steer this agent mid-run…"
				spellCheck={false}
				className="min-w-0 flex-1 bg-transparent outline-none placeholder:opacity-40"
				style={{ color: "var(--text)", caretColor: "var(--cyan)" }}
			/>
			{flash === "sent" && <span style={{ color: "var(--green)" }}>sent ✓</span>}
			{flash === "failed" && <span style={{ color: "var(--red)" }}>failed ✗</span>}
		</div>
	);
}
