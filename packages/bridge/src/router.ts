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

/** An approval gate as it crosses the wire (timeout/default stay host-side). */
export interface ApprovalRequestWire {
	taskId: string;
	question: string;
	options: string[];
}

/**
 * The HITL surface of a live TeamOrchestrator run. The orchestrator class
 * satisfies resume/pendingApprovals structurally; trace wraps buildTrace with
 * the run session closed over. Hosts attach it after the server starts (runs
 * begin later), hence the getter in RouterOptions.
 */
export interface HitlRun {
	runId: string;
	resume(taskId: string, chosenOption: string, feedback?: string): boolean;
	pendingApprovals(): ApprovalRequestWire[];
	trace(runId?: string): Promise<unknown>;
}

/** One dag node as posted to POST /runs. */
export interface StartRunTask {
	id: string;
	role: string;
	/** Text that starts the node's run. Defaults to the task id. */
	prompt?: string;
	/** Ids of tasks that must finish before this one starts. */
	deps?: string[];
}

export interface StartRunRequest {
	tasks: StartRunTask[];
}

/**
 * Thrown by a RouterOptions.startRun handler to reject a run with a specific
 * wire status: 409 when a run is already active, 400 for semantic errors the
 * router can't see (unknown role, duplicate task id, dependency cycle).
 */
export class RunRejectedError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409 = 400,
	) {
		super(message);
		this.name = "RunRejectedError";
	}
}

export interface RouterOptions {
	/** Current run for the HITL routes, or undefined when none is active. */
	hitl?: () => HitlRun | undefined;
	/**
	 * Start a TeamOrchestrator run from a task graph. The handler owns dag
	 * construction and run lifecycle; it throws RunRejectedError to refuse.
	 * Absent, POST /runs responds 404.
	 */
	startRun?: (request: StartRunRequest) => Promise<{ runId: string }>;
}

/** Shape-validate a POST /runs body. Returns an error message, or undefined when valid. */
function validateStartRun(body: { tasks?: unknown }): string | undefined {
	if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
		return "Expected { tasks: [{ id, role, prompt?, deps? }] } with at least one task";
	}
	for (const task of body.tasks as Array<Record<string, unknown> | null>) {
		if (
			task === null ||
			typeof task !== "object" ||
			typeof task.id !== "string" ||
			task.id.length === 0 ||
			typeof task.role !== "string" ||
			task.role.length === 0
		) {
			return 'Each task needs non-empty string fields "id" and "role"';
		}
		if (task.prompt !== undefined && typeof task.prompt !== "string") {
			return `Task "${task.id}": "prompt" must be a string`;
		}
		if (task.deps !== undefined && (!Array.isArray(task.deps) || task.deps.some((dep) => typeof dep !== "string"))) {
			return `Task "${task.id}": "deps" must be an array of task ids`;
		}
	}
	return undefined;
}

/**
 * Bun-native router for the bridge.
 *
 *   GET  /events           SSE stream, all agents (replay + live)
 *   GET  /events/:role     SSE stream, one agent (?replay=N limits replay)
 *   POST /steer            { role, message } → queue a steering message
 *   GET  /status           { [role]: { status, lastEventType } }
 *   GET  /health           { ok: true }
 *
 * HITL wire contract, consumed identically by hoocanvas and hoocode --team
 * (404 on all of these while no run is attached):
 *
 *   POST /runs                   { tasks: [{ id, role, prompt?, deps? }] } →
 *                                202 { runId }; 409 while a run is active; 400
 *                                on bad shape, unknown role, or cyclic deps.
 *                                404 when the host wired no startRun handler.
 *   GET  /tasks/pending          { runId, pending: [{ taskId, question, options }] }
 *   POST /tasks/:taskId/resume   { option, feedback? } → { ok, taskId }; 409 when
 *                                nothing is pending for the task (unknown, or
 *                                another surface answered first — first answer wins)
 *   GET  /trace                  TraceRun of the attached run
 *   GET  /runs/:runId/trace      TraceRun for one run id
 */
export function createRouter(team: Team, channel: TeamChannel, bridge: SSEBridge, routerOptions: RouterOptions = {}): Router {
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

			if (request.method === "POST" && path === "/runs") {
				if (!routerOptions.startRun) {
					return json({ error: "This server does not start runs" }, 404);
				}
				let body: { tasks?: unknown };
				try {
					body = (await request.json()) as { tasks?: unknown };
				} catch {
					return json({ error: "Body must be JSON" }, 400);
				}
				const invalid = validateStartRun(body);
				if (invalid) {
					return json({ error: invalid }, 400);
				}
				try {
					return json(await routerOptions.startRun(body as StartRunRequest), 202);
				} catch (err) {
					if (err instanceof RunRejectedError) {
						return json({ error: err.message }, err.status);
					}
					return json({ error: err instanceof Error ? err.message : String(err) }, 500);
				}
			}

			if (path === "/tasks/pending" || path === "/trace" || /^\/(tasks\/[^/]+\/resume|runs\/[^/]+\/trace)$/.test(path)) {
				const run = routerOptions.hitl?.();
				if (!run) {
					return json({ error: "No active run" }, 404);
				}
				if (request.method === "GET" && path === "/tasks/pending") {
					const pending = run.pendingApprovals().map(({ taskId, question, options }) => ({ taskId, question, options }));
					return json({ runId: run.runId, pending });
				}
				const resumeMatch = request.method === "POST" ? /^\/tasks\/([^/]+)\/resume$/.exec(path) : null;
				if (resumeMatch) {
					let body: { option?: unknown; feedback?: unknown };
					try {
						body = (await request.json()) as { option?: unknown; feedback?: unknown };
					} catch {
						return json({ error: "Body must be JSON" }, 400);
					}
					if (typeof body.option !== "string" || body.option.length === 0 || (body.feedback !== undefined && typeof body.feedback !== "string")) {
						return json({ error: "Expected { option: string, feedback?: string }" }, 400);
					}
					const taskId = decodeURIComponent(resumeMatch[1]!);
					if (!run.resume(taskId, body.option, body.feedback as string | undefined)) {
						return json({ error: `No pending approval for task "${taskId}"` }, 409);
					}
					return json({ ok: true, taskId });
				}
				if (request.method === "GET") {
					const traceMatch = /^\/runs\/([^/]+)\/trace$/.exec(path);
					if (path === "/trace" || traceMatch) {
						const runId = traceMatch ? decodeURIComponent(traceMatch[1]!) : undefined;
						return json(await run.trace(runId));
					}
				}
				return json({ error: "Not found" }, 404);
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
