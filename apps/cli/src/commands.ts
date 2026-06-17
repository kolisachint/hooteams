import { createHoocodeAuth, getModel, Planner, type RoleConfig, Team, TeamChannel } from "@kolisachint/hooteams-orchestrator";
import { loadConfig, type RunningServer, startServer } from "@kolisachint/hooteams-server";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { StreamRenderer } from "./render.js";
import { consumeSSE } from "./sse.js";

/** A planned task graph: what the dry-run planner produces and `/runs` accepts. */
interface PlanDocument {
	goal: string;
	roles: RoleConfig[];
	tasks: Array<{ id: string; role: string; deps?: string[] }>;
}

export async function nudge(host: string, role: string, message: string): Promise<void> {
	const response = await fetch(`${host}/steer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ role, message }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${response.status}`);
	}
	console.log(`nudged ${role} ✓`);
}

export async function status(host: string): Promise<void> {
	const response = await fetch(`${host}/status`);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const snapshot = (await response.json()) as Record<string, { status: string; lastEventType?: string }>;
	const roles = Object.keys(snapshot);
	if (roles.length === 0) {
		console.log("no agents running");
		return;
	}
	const width = Math.max(...roles.map((role) => role.length));
	for (const [role, info] of Object.entries(snapshot)) {
		const last = info.lastEventType ? `  (last: ${info.lastEventType})` : "";
		console.log(`${role.padEnd(width)}  ${info.status}${last}`);
	}
}

/**
 * POST a task graph to /runs and follow its lifecycle on /events until the
 * dag settles. The file holds { tasks: [{ id, role, prompt?, deps? }] } (a
 * bare task array is accepted too). Detaching leaves the run going.
 */
export async function run(host: string, file: string, follow: boolean): Promise<void> {
	const parsed = JSON.parse(await Bun.file(file).text()) as unknown;
	const body = Array.isArray(parsed) ? { tasks: parsed } : parsed;
	const { failed } = await submitAndFollow(host, body, follow);
	if (failed) process.exit(1);
}

/**
 * POST a task graph to /runs and, when `follow`, stream its lifecycle on /events
 * until the dag settles. Returns the run id and whether it failed — the caller
 * decides how to exit (so an ephemeral server can be torn down first).
 */
export async function submitAndFollow(
	host: string,
	body: unknown,
	follow: boolean,
): Promise<{ runId: string; failed: boolean; validationReason?: string }> {
	const response = await fetch(`${host}/runs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(error.error ?? `HTTP ${response.status}`);
	}
	const { runId } = (await response.json()) as { runId: string };
	console.log(`run started: ${runId}`);
	if (!follow) return { runId, failed: false };
	console.log("following the run — ctrl-c detaches (the run keeps going)\n");

	let failed = false;
	// The goal validator reports an unmet goal as an orchestrator-level team_error
	// (agentId === runId); --loop feeds the reason into the next plan.
	let validationReason: string | undefined;
	const controller = new AbortController();
	await consumeSSE(
		`${host}/events?replay=50`,
		(event) => {
			switch (event.type) {
				case "task_started":
					console.log(`▶ ${event.taskId} (${event.role})`);
					break;
				case "task_paused":
					console.log(`⏸ ${event.taskId} needs input: ${event.question}`);
					console.log(`   options: ${(event.options ?? []).join(", ")}`);
					console.log(`   answer with: hooteams resume ${event.taskId} "<option>"`);
					break;
				case "task_resumed":
					console.log(`▶ ${event.taskId} resumed with "${event.chosenOption}"`);
					break;
				case "task_retried":
					console.log(`↻ ${event.taskId} retrying (attempt ${event.attempt}): ${event.error}`);
					break;
				case "task_finished":
					console.log(`${event.status === "done" ? "✓" : "✗"} ${event.taskId} ${event.status}`);
					break;
				case "team_error":
					if (event.agentId === runId) {
						validationReason = event.error;
						console.log(`⚠ ${event.error}`);
					}
					break;
				case "dag_complete":
				case "dag_failed":
					if (event.runId !== runId) break;
					failed = event.type === "dag_failed";
					console.log(`\nrun ${failed ? "failed" : "complete"}: ${runId}`);
					controller.abort();
					break;
			}
		},
		controller.signal,
	);
	return { runId, failed, validationReason };
}

/**
 * Run the planner in dry-run mode against a goal: spawn_agent/delegate_task
 * record a plan instead of starting agents, so the task graph can be reviewed
 * before anything runs. Prints the plan; with --out, writes a tasks.json that
 * `hooteams run` accepts directly (the file carries goal + roles + tasks, and
 * the server merges the plan's roles into the team for that run).
 */
export async function plan(goal: string, outFile?: string, modelId?: string, provider?: string): Promise<void> {
	const document = await runPlanner(goal, modelId, provider);
	if (!document) {
		console.log("\nthe planner produced no tasks");
		return;
	}
	printPlan(document);
	const json = `${JSON.stringify(document, null, "\t")}\n`;
	if (outFile) {
		await Bun.write(outFile, json);
		console.log(`\nwrote ${outFile} — review it, then start the run with: hooteams run ${outFile}`);
	} else {
		console.log(`\n${json}`);
	}
}

/**
 * Run the dry-run planner against a goal in-process and return the planned task
 * graph ({ goal, roles, tasks }), or null when it produces no tasks. Planning
 * needs no server — spawn_agent/delegate_task only record the plan.
 */
export async function runPlanner(goal: string, modelId?: string, provider?: string, configPath?: string): Promise<PlanDocument | null> {
	// The configured team (with categories) is fed to the planner as a roster so
	// it routes tasks to the right agent tier. Config problems shouldn't block
	// planning, so a load failure just means no roster.
	let availableRoles: RoleConfig[] = [];
	try {
		availableRoles = (await loadConfig(configPath)).team;
	} catch (error) {
		console.error(`(planner) ignoring team config: ${error instanceof Error ? error.message : String(error)}`);
	}
	const channel = new TeamChannel();
	const getApiKey = createHoocodeAuth();
	const team = new Team(channel, { getApiKey });
	const renderer = new StreamRenderer();
	channel.subscribe((event) => renderer.render(event));
	const planner = new Planner({
		team,
		dryRun: true,
		getApiKey,
		availableRoles,
		model: modelId ? getModel((provider ?? "anthropic") as any, modelId as any) : undefined,
	});
	await planner.plan(goal);
	const buffer = planner.planBuffer!;
	if (buffer.tasks.length === 0) return null;
	return { goal, roles: buffer.roles, tasks: buffer.tasks };
}

function printPlan(document: PlanDocument): void {
	console.log(`\nplan: ${document.roles.length} role(s), ${document.tasks.length} task(s)`);
	for (const task of document.tasks) {
		const after = task.deps && task.deps.length > 0 ? ` (after ${task.deps.join(", ")})` : "";
		console.log(`  ${task.id} → ${task.role}${after}`);
	}
}

export interface WorkOptions {
	config?: string;
	model?: string;
	provider?: string;
	/** Leave an ephemeral server running after the run (keeps the web UI up). */
	keep?: boolean;
	/** Submit and exit without following (requires an already-running server). */
	detach?: boolean;
	allowAutonomous?: boolean;
	webui?: boolean;
	/** Also persist the plan to this file. */
	out?: string;
	/** Re-plan and re-run until the goal is verified met or maxIterations is hit. */
	loop?: boolean;
	/** Cap on --loop iterations. Default 3. */
	maxIterations?: number;
	/** Goal-completion validator prompt; sets/overrides the booted server's validator. */
	verify?: string;
}

/** Default validator prompt used by --loop when the config sets none. */
export const DEFAULT_VERIFY_PROMPT =
	"You are a strict reviewer. Given the team's goal and every task's output, judge whether the goal was actually achieved — completed tasks alone do not prove it. Only declare success when the goal is genuinely met.";

/**
 * One-shot entry point: plan a goal, ensure a server is running, submit the
 * plan, and follow it to completion. If a server is reachable at `host` it is
 * reused; otherwise an ephemeral in-process server is booted for the duration
 * and stopped when the run settles (unless --keep).
 *
 * With `--loop`, it re-plans and re-runs until the server's goal validator
 * verifies the goal (a clean settle) or `maxIterations` is reached, feeding each
 * unmet verdict back into the next plan. Verification relies on a configured
 * validator; when booting a server, one is injected if the config sets none.
 */
export async function work(host: string, goal: string, opts: WorkOptions = {}): Promise<void> {
	const reachable = await serverReachable(host);
	if (!reachable && opts.detach) {
		throw new Error("--detach needs a running server — start one with `hooteams start`, or drop --detach");
	}
	if (opts.loop && opts.detach) {
		throw new Error("--loop and --detach are incompatible — looping must follow each run to verify it");
	}

	let booted: RunningServer | undefined;
	let baseUrl = host;
	if (reachable) {
		console.log(`using running server at ${host}`);
		if (opts.loop) {
			console.log("note: --loop verifies via the server's goal validator — ensure this server has one configured");
		}
	} else {
		const config = await loadConfig(opts.config);
		// --loop needs a validator to verify "done"; inject a default if none set.
		if (opts.verify) config.validator = opts.verify;
		else if (opts.loop && !config.validator) config.validator = DEFAULT_VERIFY_PROMPT;
		booted = startServer(config, {
			allowAutonomous: opts.allowAutonomous || undefined,
			webui: opts.webui === false ? false : undefined,
		});
		baseUrl = `http://localhost:${booted.port}`;
		console.log(`booted server on ${baseUrl}`);
		if (booted.webuiRoot) console.log(`live web UI:  ${baseUrl}`);
		if (config.team.length > 0) console.log(`team: ${config.team.map(formatRole).join(", ")}`);
	}

	let failed = false;
	try {
		if (opts.loop) {
			const met = await runLoop(goal, Math.max(1, opts.maxIterations ?? 3), (iterGoal, iter) =>
				runIteration(baseUrl, iterGoal, iter, opts),
			);
			failed = !met;
		} else {
			failed = await runSingle(baseUrl, goal, opts);
		}
	} catch (error) {
		if (booted && !opts.keep) await booted.stop();
		throw error;
	}

	if (booted) {
		if (opts.keep) {
			console.log(`\nserver still running on ${baseUrl} — ctrl-c or \`hooteams stop\` to shut down`);
			const shutdown = async (): Promise<void> => {
				await booted!.stop();
				process.exit(failed ? 1 : 0);
			};
			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());
			return; // the listening server keeps the process alive
		}
		await booted.stop();
	}
	if (failed) process.exit(1);
}

/** Plan + run once. Returns whether the run failed. */
async function runSingle(baseUrl: string, goal: string, opts: WorkOptions): Promise<boolean> {
	const document = await runPlanner(goal, opts.model, opts.provider, opts.config);
	if (!document) {
		console.log("\nthe planner produced no tasks");
		return false;
	}
	printPlan(document);
	if (opts.out) {
		await Bun.write(opts.out, `${JSON.stringify(document, null, "\t")}\n`);
		console.log(`\nwrote ${opts.out}`);
	}
	console.log("");
	const { failed } = await submitAndFollow(baseUrl, document, !opts.detach);
	return failed;
}

/** Outcome of one --loop iteration, as seen by the loop's control flow. */
export interface IterationOutcome {
	/** False when the planner produced no tasks — the loop can't continue. */
	hasTasks: boolean;
	/** True when the goal validator verified the goal (a clean settle). */
	met: boolean;
	/** Why the goal wasn't met, fed into the next iteration's plan. */
	reason?: string;
}

/**
 * Drive the re-plan/re-run loop: each iteration's goal carries the previous
 * unmet verdict as feedback. Stops as soon as `met` is true (verified), when an
 * iteration yields no tasks, or after `maxIterations`. The per-iteration work is
 * injected so the control flow can be tested without a server or LLM.
 */
export async function runLoop(
	goal: string,
	maxIterations: number,
	runIteration: (iterGoal: string, iter: number) => Promise<IterationOutcome>,
): Promise<boolean> {
	let feedback = "";
	for (let iter = 1; iter <= maxIterations; iter++) {
		console.log(`\n— iteration ${iter}/${maxIterations} —`);
		const iterGoal = feedback ? `${goal}\n\nA previous attempt fell short: ${feedback}\nFix the gap and complete the goal.` : goal;
		const outcome = await runIteration(iterGoal, iter);
		if (!outcome.hasTasks) {
			console.log("\nthe planner produced no tasks");
			return false;
		}
		if (outcome.met) {
			console.log(`\n✓ goal verified after ${iter} iteration(s)`);
			return true;
		}
		feedback = outcome.reason ?? "the run failed before the goal could be verified";
		console.log(`\n↻ not verified: ${feedback}`);
	}
	console.log(`\n✗ goal not verified after ${maxIterations} iteration(s)`);
	return false;
}

/** One real loop iteration: plan, then submit + follow the run to a verdict. */
async function runIteration(baseUrl: string, iterGoal: string, _iter: number, opts: WorkOptions): Promise<IterationOutcome> {
	const document = await runPlanner(iterGoal, opts.model, opts.provider, opts.config);
	if (!document) return { hasTasks: false, met: false };
	printPlan(document);
	console.log("");
	const result = await submitAndFollow(baseUrl, document, true);
	return { hasTasks: true, met: !result.failed, reason: result.validationReason };
}

/** True when a hooteams server answers /status at `host`. */
async function serverReachable(host: string): Promise<boolean> {
	try {
		const response = await fetch(`${host}/status`, { signal: AbortSignal.timeout(1000) });
		return response.ok;
	} catch {
		return false;
	}
}

function formatRole(role: { role: string; category?: string }): string {
	return role.category ? `${role.role} (${role.category})` : role.role;
}

/** A scaffold file `hooteams init` writes (path is relative to the project root). */
interface ScaffoldFile {
	path: string;
	content: string;
}

const TEAM_JSON = `${JSON.stringify(
	{
		defaults: { provider: "anthropic", model: "claude-sonnet-4-5" },
		maxConcurrent: 3,
		rulesDir: ".agents/teams/rules",
		team: [
			{ role: "planner", category: "plan", systemPrompt: "You are the planner. Break the goal into tasks and coordinate the team." },
			{ role: "coder", category: "deep", defaultTools: true, systemPrompt: "You are the coder. Implement tasks one at a time, with tests." },
			{ role: "reviewer", category: "quick", defaultTools: true, systemPrompt: "You are the reviewer. Check the work against the goal and flag gaps." },
		],
	},
	null,
	"\t",
)}\n`;

const STYLE_RULE = `# Project rules

Markdown files in \`.agents/teams/rules/\` are injected into every agent's system
prompt as project context. Use them for conventions every agent must follow.

- Match the existing code style.
- Write tests for new behavior.
- Keep changes focused; don't refactor unrelated code.
`;

const AGENTS_STUB = `# AGENTS.md

Guidance for AI agents working in this project. This file lives in the rules
directory, so it is injected into every agent's system prompt.

- Team config: \`.agents/teams/team.json\`
- Project rules: \`.agents/teams/rules/\`

Describe the project, its conventions, and anything every agent must know.
`;

export interface InitOptions {
	/** Overwrite files that already exist. Default: skip them. */
	force?: boolean;
	/** Project root to scaffold into. Defaults to process.cwd(). */
	cwd?: string;
}

/**
 * Scaffold the hooteams conventions into the current project, all under
 * `.agents/teams/`: a discoverable team config and a rules directory holding a
 * starter rule plus an AGENTS.md (both injected into agent prompts via the
 * rules channel). Existing files are left untouched unless --force, so it's safe
 * to run in an established repo.
 */
export async function init(opts: InitOptions = {}): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const files: ScaffoldFile[] = [
		{ path: join(".agents", "teams", "team.json"), content: TEAM_JSON },
		{ path: join(".agents", "teams", "rules", "00-style.md"), content: STYLE_RULE },
		{ path: join(".agents", "teams", "rules", "AGENTS.md"), content: AGENTS_STUB },
	];
	let wrote = 0;
	for (const file of files) {
		const exists = await Bun.file(join(cwd, file.path)).exists();
		if (exists && !opts.force) {
			console.log(`skip   ${file.path} (exists)`);
			continue;
		}
		await Bun.write(join(cwd, file.path), file.content); // creates parent dirs
		console.log(`${exists ? "overwrote" : "created"}  ${file.path}`);
		wrote++;
	}
	console.log(
		wrote > 0
			? `\nScaffolded ${wrote} file(s). Edit .agents/teams/team.json, then: hooteams work "<goal>"`
			: "\nNothing to do — all scaffold files already exist (use --force to overwrite).",
	);
}

/** List the active run's unanswered approval gates. */
export async function pending(host: string): Promise<void> {
	const response = await fetch(`${host}/tasks/pending`);
	if (response.status === 404) {
		console.log("no active run");
		return;
	}
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = (await response.json()) as {
		runId: string;
		pending: Array<{ taskId: string; question: string; options: string[] }>;
	};
	if (data.pending.length === 0) {
		console.log(`run ${data.runId}: no pending approvals`);
		return;
	}
	for (const gate of data.pending) {
		console.log(`${gate.taskId}: ${gate.question}`);
		console.log(`  options: ${gate.options.join(", ")}`);
	}
}

/** Answer a paused task's approval gate. */
export async function resume(host: string, taskId: string, option: string, feedback?: string): Promise<void> {
	const response = await fetch(`${host}/tasks/${encodeURIComponent(taskId)}/resume`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ option, feedback }),
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(error.error ?? `HTTP ${response.status}`);
	}
	console.log(`resumed ${taskId} with "${option}" ✓`);
}

export async function stop(host: string): Promise<void> {
	const response = await fetch(`${host}/stop`, { method: "POST" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	console.log("server stopping");
}

/**
 * Attach this terminal to a running agent: replay recent events, follow live,
 * [n] to nudge, [q] to detach (the agent keeps running).
 */
export async function attach(host: string, role: string, replay: number): Promise<void> {
	console.log(`attached: ${role} — [q]uit  [n]udge`);
	const renderer = new StreamRenderer();
	const controller = new AbortController();

	const stdin = process.stdin;
	const interactive = stdin.isTTY === true;
	let paused = false;

	const onKey = (data: Buffer): void => {
		if (paused) return;
		const key = data.toString();
		if (key === "q" || key === "\x03") {
			controller.abort();
			cleanup();
			console.log(`\ndetached from ${role} (agent keeps running)`);
			process.exit(0);
		}
		if (key === "n") {
			paused = true;
			stdin.setRawMode?.(false);
			const readline = createInterface({ input: process.stdin, output: process.stdout });
			readline
				.question("\nnudge > ")
				.then(async (message) => {
					readline.close();
					if (message.trim().length > 0) {
						await nudge(host, role, message.trim()).catch((error) => console.error(String(error)));
					}
					stdin.setRawMode?.(true);
					paused = false;
				})
				.catch(() => {
					readline.close();
					paused = false;
				});
		}
	};

	const cleanup = (): void => {
		if (interactive) {
			stdin.setRawMode?.(false);
			stdin.off("data", onKey);
			stdin.pause();
		}
	};

	if (interactive) {
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.on("data", onKey);
	}

	try {
		await consumeSSE(`${host}/events/${encodeURIComponent(role)}?replay=${replay}`, (event) => {
			renderer.render(event);
		}, controller.signal);
		console.log("\nstream ended (server stopped)");
	} finally {
		cleanup();
	}
}
