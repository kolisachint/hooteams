import { useStore } from "./store";
import type { TeamConfig, TeamEvent } from "./types";

/**
 * Base URL for the hooteams SSE bridge. Defaults to the empty string, i.e. the
 * page's own origin: `hooteams start` serves this UI from the same port as the
 * bridge, so `${HOOTEAMS_HOST}/events` resolves to `/events` (no CORS, no
 * port coupling). Set VITE_HOOTEAMS_HOST to point a standalone `vite dev` UI at
 * a remote bridge.
 */
export const HOOTEAMS_HOST: string = import.meta.env.VITE_HOOTEAMS_HOST ?? "";

/** Human-readable host label for the connection badge. */
export const HOOTEAMS_HOST_LABEL: string =
	HOOTEAMS_HOST.replace(/^https?:\/\//, "") || (typeof window !== "undefined" ? window.location.host : "same-origin");

let source: EventSource | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
let stopped = false;

const MAX_BACKOFF_MS = 30_000;
let currentRunId: string | undefined;

// Per-frame coalescing of incoming events. A streaming agent emits token deltas
// far faster than the screen refreshes; dispatching each one separately forces a
// re-render per token, which on macOS shows up as rapid flicker of the animated
// run nodes (GPU compositing repaints under the storm). We buffer events and
// flush the whole batch once per animation frame, collapsing a burst of deltas
// into a single state update + render.
let pendingEvents: TeamEvent[] = [];
let flushHandle: number | undefined;

function flushEvents(): void {
	flushHandle = undefined;
	if (pendingEvents.length === 0) return;
	const batch = pendingEvents;
	pendingEvents = [];
	useStore.getState().dispatchMany(batch);
}

function queueEvent(event: TeamEvent): void {
	pendingEvents.push(event);
	if (flushHandle !== undefined) return;
	flushHandle =
		typeof requestAnimationFrame === "function"
			? requestAnimationFrame(flushEvents)
			: (setTimeout(flushEvents, 16) as unknown as number);
}

/**
 * Connect to the HooTeams SSE stream. Native EventSource retries on its own,
 * but gives up on some failures (e.g. server down at page load), so we manage
 * reconnection ourselves with exponential backoff capped at 30s.
 */
export function connect(host: string = HOOTEAMS_HOST, runId?: string): void {
	stopped = false;
	currentRunId = runId;
	open(host, runId);
}

function open(host: string, runId?: string): void {
	source?.close();
	const url = runId ? `${host}/events?runId=${runId}` : `${host}/events`;
	source = new EventSource(url);

	source.onopen = () => {
		attempt = 0;
		useStore.getState().setConnection("live");
	};

	source.onmessage = (event) => {
		try {
			queueEvent(JSON.parse(event.data) as TeamEvent);
		} catch {
			// Malformed frame — skip rather than tear down the stream.
		}
	};

	source.onerror = () => {
		if (stopped) return;
		useStore.getState().setConnection("reconnecting");
		source?.close();
		const backoff = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
		attempt += 1;
		clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => open(host, currentRunId), backoff);
	};
}

export function disconnect(): void {
	stopped = true;
	clearTimeout(reconnectTimer);
	if (flushHandle !== undefined) {
		if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(flushHandle);
		else clearTimeout(flushHandle);
		flushHandle = undefined;
	}
	// Drain anything buffered so a reconnect doesn't replay stale deltas.
	pendingEvents = [];
	source?.close();
	source = undefined;
}

/**
 * Resolve a human-in-the-loop approval gate. `option` is one of the choices the
 * orchestrator offered in the task_paused event; `feedback` is an optional note.
 */
export async function resumeTask(
	taskId: string,
	option: string,
	feedback?: string,
	host: string = HOOTEAMS_HOST,
): Promise<void> {
	const response = await fetch(`${host}/tasks/${encodeURIComponent(taskId)}/resume`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ option, ...(feedback ? { feedback } : {}) }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `resume failed: HTTP ${response.status}`);
	}
}

/** Snapshot of every spawned role's status — drives the sidebar's agent count. */
export async function fetchStatus(
	host: string = HOOTEAMS_HOST,
): Promise<Record<string, { status: string; lastEventType?: string }>> {
	const response = await fetch(`${host}/status`);
	if (!response.ok) throw new Error(`status failed: HTTP ${response.status}`);
	return response.json();
}

/** Current server team config (models / prompts / concurrency) — for the live run. */
export async function fetchConfig(host: string = HOOTEAMS_HOST): Promise<TeamConfig | null> {
	const response = await fetch(`${host}/config`);
	if (!response.ok) return null;
	return response.json();
}

/** The only steering operation in the web UI: nudge an agent mid-run. */
export async function steer(role: string, message: string, host: string = HOOTEAMS_HOST): Promise<void> {
	const response = await fetch(`${host}/steer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ role, message }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `steer failed: HTTP ${response.status}`);
	}
}
