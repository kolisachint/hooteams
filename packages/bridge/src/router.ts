import type { RoleConfig, Team, TeamChannel } from "@kolisachint/hooteams-orchestrator";
import { type SessionSummary, summarizeSession } from "./session-summary.js";
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
	/**
	 * Abort the active run: stop dispatching, abort live agents, fail the
	 * unfinished tasks, and settle the run. Returns false when the run had
	 * already finished (nothing to cancel). Completed tasks keep their output.
	 */
	cancel(reason?: string): boolean;
}

/** One dag node as posted to POST /runs. */
export interface StartRunTask {
	id: string;
	role: string;
	/** Text that starts the node's run. Defaults to the task id. */
	prompt?: string;
	/** Ids of tasks that must finish before this one starts. */
	deps?: string[];
	/** Extra attempts the task gets after a failed run. Default 0. */
	retries?: number;
	/**
	 * Wall-clock budget for one dispatch of the task, in milliseconds. An overrun
	 * is aborted and settles the attempt as a failure (then subject to `retries`).
	 * Unset or <= 0 means no timeout.
	 */
	timeoutMs?: number;
	/**
	 * Per-task approval policy overriding the run default: true forces a human
	 * completion gate before this task settles "done" (even in an autonomous run);
	 * false skips it. Unset follows the run default. Lets a run gate only at
	 * chosen tasks (e.g. merges) instead of every task or none.
	 */
	gate?: boolean;
	/**
	 * When true, the task's agent stays live and addressable after it settles
	 * "done", until the run ends, so later tasks can ask_agent it across phases
	 * (e.g. a schema owner answering implementers mid-build).
	 */
	advisor?: boolean;
}

export interface StartRunRequest {
	tasks: StartRunTask[];
	/**
	 * The goal the run pursues. Passed to the host's goal validator (when one
	 * is configured) so completion is judged against it.
	 */
	goal?: string;
	/**
	 * Role configs to add for this run on top of the host's configured team,
	 * e.g. the roles a dry-run plan (hooteams plan) produced. Roles already
	 * configured under the same name win.
	 */
	roles?: RoleConfig[];
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
	/**
	 * Root directory for session JSONL files. Enables GET /sessions/:runId
	 * and GET /sessions endpoints for hoocanvas replay.
	 */
	sessionsRoot?: string;
	/**
	 * Serializable team config (models, system prompts, concurrency). Enables
	 * GET /config so the web UI can show static config the SSE stream omits.
	 */
	teamConfig?: WebTeamConfig;
}

/** The serializable slice of the team config surfaced to the web UI by GET /config. */
export interface WebTeamConfig {
	defaults?: { provider?: string; model?: string; thinkingLevel?: string };
	maxConcurrent?: number;
	/** Present (and a non-empty string) when a completion validator is configured. */
	validator?: string;
	roles: Array<{
		role: string;
		model?: string;
		provider?: string;
		category?: string;
		thinkingLevel?: string;
		defaultTools?: boolean;
		systemPrompt: string;
	}>;
}

/** Shape-validate a POST /runs body. Returns an error message, or undefined when valid. */
function validateStartRun(body: { tasks?: unknown; goal?: unknown; roles?: unknown }): string | undefined {
	if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
		return "Expected { tasks: [{ id, role, prompt?, deps?, retries? }] } with at least one task";
	}
	if (body.goal !== undefined && typeof body.goal !== "string") {
		return '"goal" must be a string';
	}
	if (body.roles !== undefined) {
		if (!Array.isArray(body.roles)) {
			return '"roles" must be an array of role configs';
		}
		for (const role of body.roles as Array<Record<string, unknown> | null>) {
			if (
				role === null ||
				typeof role !== "object" ||
				typeof role.role !== "string" ||
				role.role.length === 0 ||
				typeof role.systemPrompt !== "string" ||
				typeof role.model !== "string"
			) {
				return 'Each role needs non-empty string fields "role", "systemPrompt", and "model"';
			}
		}
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
		if (task.retries !== undefined && (typeof task.retries !== "number" || !Number.isInteger(task.retries) || task.retries < 0)) {
			return `Task "${task.id}": "retries" must be a non-negative integer`;
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
 *   POST /runs/cancel            abort the active run → { ok, runId, cancelled };
 *                                409 when it already finished
 *   POST /runs/:runId/cancel     same, scoped to a run id (404 if it isn't the
 *                                active run)
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
				let body: { tasks?: unknown; goal?: unknown; roles?: unknown };
				try {
					body = (await request.json()) as { tasks?: unknown; goal?: unknown; roles?: unknown };
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

			if (
				path === "/tasks/pending" ||
				path === "/trace" ||
				path === "/runs/cancel" ||
				/^\/(tasks\/[^/]+\/resume|runs\/[^/]+\/(trace|cancel))$/.test(path)
			) {
				const run = routerOptions.hitl?.();
				if (!run) {
					return json({ error: "No active run" }, 404);
				}
				const cancelMatch = request.method === "POST" ? /^\/runs\/([^/]+)\/cancel$/.exec(path) : null;
				if (request.method === "POST" && (path === "/runs/cancel" || cancelMatch)) {
					const runId = cancelMatch ? decodeURIComponent(cancelMatch[1]!) : undefined;
					// A run id in the path must match the active run — there is only one.
					if (runId && runId !== run.runId) {
						return json({ error: `Run "${runId}" is not the active run` }, 404);
					}
					if (!run.cancel()) {
						return json({ error: "Run already finished" }, 409);
					}
					return json({ ok: true, runId: run.runId, cancelled: true });
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

			// ── Static team config (models / prompts the SSE stream omits) ──
			if (request.method === "GET" && path === "/config") {
				if (!routerOptions.teamConfig) {
					return json({ error: "Team config not available" }, 404);
				}
				return json(routerOptions.teamConfig);
			}

			// ── Session file endpoints (for hoocanvas replay) ──
			if (request.method === "GET" && path === "/sessions") {
				const sessionsRoot = routerOptions.sessionsRoot;
				if (!sessionsRoot) {
					return json({ error: "Sessions root not configured" }, 404);
				}
				try {
					const { readdir, readFile, stat } = await import("node:fs/promises");
					const { join } = await import("node:path");
					const files = await readdir(sessionsRoot, { recursive: true });
					const candidates = files
						.filter((f): f is string => typeof f === "string" && f.endsWith(".jsonl") && f.includes("run-"))
						.map((f) => {
							const match = f.match(/run-([\w-]+)\.jsonl$/);
							// `path` is absolute so the web UI can show exactly where the log lives.
							return match ? { runId: match[1]!, filename: f, path: join(sessionsRoot, f) } : null;
						})
						.filter((s): s is { runId: string; filename: string; path: string } => s !== null);
					// Read + summarize each log once, server-side, so the web UI can render
					// its run list from a single call instead of fetching and fully parsing
					// every session file itself (an N+1 request storm). Also carry the file
					// mtime to sort newest-first (readdir order is filesystem-arbitrary).
					const enriched = await Promise.all(
						candidates.map(async (s) => {
							let mtimeMs = 0;
							let summary: SessionSummary | null = null;
							try {
								mtimeMs = (await stat(s.path)).mtimeMs;
								summary = summarizeSession(await readFile(s.path, "utf-8"));
							} catch {
								// Unreadable/partial file: keep the row (id+path) but no summary,
								// and sort it last rather than failing the whole list.
							}
							return { ...s, mtimeMs, summary };
						}),
					);
					enriched.sort((a, b) => (b.summary?.startedAt ?? b.mtimeMs) - (a.summary?.startedAt ?? a.mtimeMs));
					// mtime is an internal sort key; merge the summary fields inline so the
					// response stays one flat object per run (back-compatible: runId,
					// filename, path are unchanged; goal/status/done/total/startedAt added).
					const sessions = enriched.map(({ mtimeMs: _mtimeMs, summary, ...rest }) => ({
						...rest,
						...(summary ?? {}),
					}));
					return json(sessions);
				} catch {
					return json({ error: "Failed to list sessions" }, 500);
				}
			}

			// ── Task transcript (lazy-loaded from agent session files) ──
			if (request.method === "GET" && /^\/sessions\/[^/]+\/transcript\/[^/]+$/.test(path)) {
				const parts = path.split("/");
				const runId = decodeURIComponent(parts[2]!);
				const taskId = decodeURIComponent(parts[4]!);
				if (!runId || !taskId) {
					return json({ error: "Missing run ID or task ID" }, 400);
				}
				const sessionsRoot = routerOptions.sessionsRoot;
				if (!sessionsRoot) {
					return json({ error: "Sessions root not configured" }, 404);
				}
				try {
					const { readdir, readFile } = await import("node:fs/promises");
					const { join } = await import("node:path");
					const files = await readdir(sessionsRoot, { recursive: true });
					// Agent session files follow the pattern: {ts}_{runId}-{taskId}.jsonl
					const agentFile = files
						.filter((f): f is string => typeof f === "string" && f.endsWith(".jsonl"))
						.find((f) => f.includes(`${runId}-${taskId}`) && !f.includes(`run-${runId}`));
					if (!agentFile) {
						return json({ error: `Transcript not found for task "${taskId}"` }, 404);
					}
					const content = await readFile(join(sessionsRoot, agentFile), "utf-8");
					return new Response(content, {
						headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
					});
				} catch {
					return json({ error: "Failed to read transcript" }, 500);
				}
			}

			if (request.method === "GET" && path.startsWith("/sessions/")) {
				const runId = decodeURIComponent(path.slice("/sessions/".length));
				if (!runId || runId.length === 0) {
					return json({ error: "Missing run ID" }, 400);
				}
				const sessionsRoot = routerOptions.sessionsRoot;
				if (!sessionsRoot) {
					return json({ error: "Sessions root not configured" }, 404);
				}
				try {
					const { readdir } = await import("node:fs/promises");
					const { join } = await import("node:path");
					const { readFile } = await import("node:fs/promises");
					// Search for the session file containing the run ID
					const files = await readdir(sessionsRoot, { recursive: true });
					const sessionFile = files
						.filter((f): f is string => typeof f === "string" && f.endsWith(".jsonl"))
						.find((f) => f.includes(runId));
					if (!sessionFile) {
						return json({ error: `Session not found: ${runId}` }, 404);
					}
					const content = await readFile(join(sessionsRoot, sessionFile), "utf-8");
					return new Response(content, {
						headers: {
							...CORS_HEADERS,
							"Content-Type": "text/plain; charset=utf-8",
						},
					});
				} catch {
					return json({ error: "Failed to read session" }, 500);
				}
			}

			return json({ error: "Not found" }, 404);
		},
	};
}
