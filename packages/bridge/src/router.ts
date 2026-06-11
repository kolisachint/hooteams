import type { Team, TeamChannel } from "@kolisachint/hooteams-orchestrator";
import type { SSEBridge } from "./sse.js";

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

const SSE_HEADERS = {
	...CORS_HEADERS,
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
	});
}

export interface Router {
	fetch(request: Request): Response | Promise<Response>;
}

/**
 * Bun-native router for the bridge.
 *
 *   GET  /events           SSE stream, all agents (replay + live)
 *   GET  /events/:role     SSE stream, one agent (?replay=N limits replay)
 *   POST /steer            { role, message } → queue a steering message
 *   GET  /status           { [role]: { status, lastEventType } }
 *   GET  /health           { ok: true }
 */
export function createRouter(team: Team, channel: TeamChannel, bridge: SSEBridge): Router {
	return {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			const path = url.pathname.replace(/\/+$/, "") || "/";

			if (request.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}

			if (request.method === "GET" && path === "/health") {
				return json({ ok: true });
			}

			if (request.method === "GET" && path === "/status") {
				const statuses = team.status();
				const snapshot: Record<string, { status: string; lastEventType?: string }> = {};
				for (const [role, status] of Object.entries(statuses)) {
					snapshot[role] = { status, lastEventType: channel.replay(role, 1)[0]?.type };
				}
				return json(snapshot);
			}

			if (request.method === "GET" && (path === "/events" || path.startsWith("/events/"))) {
				const role = path === "/events" ? undefined : decodeURIComponent(path.slice("/events/".length));
				if (role !== undefined && role.length === 0) {
					return json({ error: "Missing role" }, 400);
				}
				const replayParam = url.searchParams.get("replay");
				const replayLimit = replayParam ? Number.parseInt(replayParam, 10) : undefined;
				if (replayLimit !== undefined && (Number.isNaN(replayLimit) || replayLimit < 0)) {
					return json({ error: "Invalid replay parameter" }, 400);
				}
				return new Response(bridge.stream(role, replayLimit), { headers: SSE_HEADERS });
			}

			if (request.method === "POST" && path === "/steer") {
				let body: { role?: unknown; message?: unknown };
				try {
					body = (await request.json()) as { role?: unknown; message?: unknown };
				} catch {
					return json({ error: "Body must be JSON" }, 400);
				}
				if (typeof body.role !== "string" || typeof body.message !== "string" || body.message.length === 0) {
					return json({ error: "Expected { role: string, message: string }" }, 400);
				}
				if (!team.has(body.role)) {
					return json({ error: `No agent for role "${body.role}"` }, 404);
				}
				team.steer(body.role, body.message);
				return json({ ok: true, role: body.role });
			}

			return json({ error: "Not found" }, 404);
		},
	};
}
