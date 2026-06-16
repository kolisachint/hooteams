/** Live activity feed — scrolling log of run/agent events. */
import { useEffect, useRef } from "react";
import { fmtT, statColor } from "../lib/roles";
import type { FeedEvent, FeedKind } from "../lib/types";

const KIND_LABEL: Record<FeedKind, string> = {
	start: "start",
	tool: "tool",
	done: "done",
	gate: "gate",
	approve: "ok",
	reject: "halt",
	retry: "retry",
	error: "error",
};

function kindColor(kind: FeedKind): string {
	if (kind === "done") return statColor("done");
	if (kind === "tool") return statColor("tool");
	if (kind === "gate" || kind === "approve") return statColor("gate");
	if (kind === "retry" || kind === "reject" || kind === "error") return statColor("error");
	return statColor("running");
}

export function Feed({
	events,
	startedAt,
	filter,
	onFilter,
	filters,
}: {
	events: FeedEvent[];
	startedAt?: number;
	filter: string;
	onFilter: (r: string) => void;
	filters: string[];
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [events.length]);

	const t0 = startedAt ?? events[0]?.ts ?? 0;
	const shown = filter === "all" ? events : events.filter((e) => e.role === filter);
	const newestId = events.length > 0 ? events[events.length - 1]!.id : null;

	return (
		<div className="col col-feed">
			<div className="col-head">
				<span className="eye t-eyebrow">Activity</span>
				<span className="count">{events.length} events</span>
			</div>
			<div className="feed-filters">
				{["all", ...filters].map((r) => (
					<button type="button" key={r} className={`chip${filter === r ? " on" : ""}`} onClick={() => onFilter(r)}>
						{r}
					</button>
				))}
			</div>
			<div className="feed-scroll" ref={ref}>
				{shown.length === 0 ? (
					<div className="feed-empty">no activity yet</div>
				) : (
					shown.map((e) => (
						<div
							key={e.id}
							className={`fev k-${e.kind}${e.id === newestId ? " is-new" : ""}`}
							style={{ "--sc": kindColor(e.kind) } as React.CSSProperties}
						>
							<div className="fev-t">{fmtT((e.ts - t0) / 1000)}</div>
							<div className="fev-main">
								<div className="fev-head">
									<span className="fev-role">{e.role}</span>
									<span className="fev-kind">{KIND_LABEL[e.kind]}</span>
								</div>
								<div className="fev-text">{e.text}</div>
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}
