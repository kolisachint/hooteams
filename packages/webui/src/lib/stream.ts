import { useStore } from "./store";
import type { TeamEvent } from "./types";

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
			useStore.getState().dispatch(JSON.parse(event.data) as TeamEvent);
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
