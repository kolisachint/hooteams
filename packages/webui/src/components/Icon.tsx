/** Lucide-style icon set (1.6px stroke), ported from the design handoff. */
import type { CSSProperties } from "react";

const IP: Record<string, string> = {
	graph: "M5 3v4a2 2 0 0 0 2 2h6a2 2 0 0 1 2 2v4M5 3 3 5m2-2 2 2M19 21v-4M17 19l2 2 2-2M5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
	timeline: "M3 4h10M3 9h14M3 14h7M3 19h11",
	activity: "M3 12h4l2 6 4-14 2 8h6",
	sun: "M12 4V2M12 22v-2M6 6 4.5 4.5M19.5 19.5 18 18M4 12H2M22 12h-2M6 18l-1.5 1.5M19.5 4.5 18 6M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
	moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
	sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
	x: "M18 6 6 18M6 6l12 12",
	check: "M20 6 9 17l-5-5",
	alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
	info: "M12 16v-4M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
	lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
	shield: "M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3Z",
	zap: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
	retry: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
	replay: "M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.4 2.6L3 8M3 3v5h5",
	users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
	coins: "M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM18.1 8.6a6 6 0 1 1-8.5 8.5",
	arrow: "M5 12h14M13 6l6 6-6 6",
	send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
	pause: "M6 4h4v16H6zM14 4h4v16h-4z",
	play: "M6 4l14 8-14 8V4Z",
	cpu: "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M5 5h14v14H5zM9 9h6v6H9z",
	dot: "M12 12h.01",
	terminal: "M4 17l6-6-6-6M12 19h8",
	clock: "M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
	plus: "M12 5v14M5 12h14",
	wrench: "M14.7 6.3a4 4 0 0 0-5.2 5.2L3 18l3 3 6.5-6.5a4 4 0 0 0 5.2-5.2l-2.8 2.8-2.4-.4-.4-2.4 2.8-2.8Z",
	search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
	file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6",
	eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
	chevR: "M9 6l6 6-6 6",
	chevL: "M15 6l-6 6 6 6",
	chevD: "M6 9l6 6 6-6",
	menu: "M4 6h16M4 12h16M4 18h16",
	link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
	message:
		"M21 11.5a8.38 8.38 0 0 1-9 8.3 8.5 8.5 0 0 1-3.9-.9L3 20l1.1-4.1A8.38 8.38 0 0 1 3 11.5a8.5 8.5 0 0 1 17 0Z",
};

export function Icon({ name, size = 16, style }: { name: string; size?: number; style?: CSSProperties }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
			aria-hidden="true"
		>
			<path d={IP[name] ?? IP.dot} />
		</svg>
	);
}
