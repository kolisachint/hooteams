import {
	createHoocodeAuth,
	discoverHoocodeDefaults,
	discoverModelCategories,
	Planner,
	resolveTeamModel,
	type RoleConfig,
	Team,
	TeamChannel,
} from "@kolisachint/hooteams-orchestrator";
import { loadConfig, type RunningServer, startServer } from "@kolisachint/hooteams-server";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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

/** Where named workflow task graphs live, relative to the project root. */
const WORKFLOWS_DIR = join(".agents", "workflows");

/**
 * A named, reusable task graph stored under `.agents/workflows/<name>.json`. It
 * is the same document `POST /runs` (and `hooteams run`) accepts — a static plan
 * that bypasses the planner for deterministic pipelines. `name`/`description`
 * are optional metadata for `hooteams workflow list`.
 */
export interface WorkflowDocument {
	name?: string;
	description?: string;
	goal?: string;
	roles?: RoleConfig[];
	tasks: Array<{ id: string; role: string; prompt?: string; deps?: string[] }>;
}

/** A workflow's at-a-glance digest for `hooteams workflow list`. */
interface WorkflowSummary {
	name: string;
	description?: string;
	goal?: string;
	taskCount: number;
}

/**
 * Resolve a workflow name to its file path. A bare name maps to
 * `.agents/workflows/<name>.json`; an explicit path (containing a separator or a
 * `.json` suffix) is used as-is so workflows can live anywhere.
 */
export function workflowPath(nameOrPath: string, cwd = process.cwd()): string {
	if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".json")) {
		return resolve(cwd, nameOrPath);
	}
	return join(cwd, WORKFLOWS_DIR, `${nameOrPath}.json`);
}

/**
 * Read and shape-check a workflow document from disk. Throws a descriptive error
 * when the file is missing or has no tasks, so the CLI can report it cleanly.
 */
export async function loadWorkflow(nameOrPath: string, cwd = process.cwd()): Promise<WorkflowDocument> {
	const path = workflowPath(nameOrPath, cwd);
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`workflow not found: ${nameOrPath} (looked in ${path})`);
	}
	const doc = JSON.parse(await file.text()) as WorkflowDocument;
	if (!Array.isArray(doc.tasks) || doc.tasks.length === 0) {
		throw new Error(`workflow "${nameOrPath}" has no tasks — expected { goal?, roles?, tasks: [...] }`);
	}
	return doc;
}

/** Discover and digest the workflows under `.agents/workflows/`, sorted by name. */
export function listWorkflowFiles(cwd = process.cwd()): WorkflowSummary[] {
	const dir = join(cwd, WORKFLOWS_DIR);
	if (!existsSync(dir)) return [];
	const summaries: WorkflowSummary[] = [];
	for (const entry of readdirSync(dir)) {
		if (extname(entry) !== ".json") continue;
		const name = basename(entry, ".json");
		try {
			const doc = JSON.parse(readFileSync(join(dir, entry), "utf-8")) as WorkflowDocument;
			summaries.push({
				name,
				description: typeof doc.description === "string" ? doc.description : undefined,
				goal: typeof doc.goal === "string" ? doc.goal : undefined,
				taskCount: Array.isArray(doc.tasks) ? doc.tasks.length : 0,
			});
		} catch {
			// A malformed workflow file shouldn't break the listing of the rest.
			summaries.push({ name, taskCount: 0 });
		}
	}
	return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Print the discovered workflows (name, task count, goal/description). */
export function listWorkflows(cwd = process.cwd()): void {
	const workflows = listWorkflowFiles(cwd);
	if (workflows.length === 0) {
		console.log(`no workflows found in ${WORKFLOWS_DIR}/`);
		console.log("create one: a .json task graph ({ goal?, roles?, tasks }), the same shape `hooteams run` accepts");
		return;
	}
	const width = Math.max(...workflows.map((w) => w.name.length));
	for (const wf of workflows) {
		const summary = wf.description ?? wf.goal ?? "";
		const tasks = `${wf.taskCount} task${wf.taskCount === 1 ? "" : "s"}`;
		console.log(`${wf.name.padEnd(width)}  ${tasks}${summary ? `  — ${summary}` : ""}`);
	}
}

/**
 * Run a named workflow: load `.agents/workflows/<name>.json` and submit it to
 * `/runs`, following the run to completion unless detached. The planner is
 * bypassed entirely — the workflow IS the plan.
 */
export async function runWorkflow(host: string, nameOrPath: string, follow: boolean, cwd = process.cwd()): Promise<void> {
	const doc = await loadWorkflow(nameOrPath, cwd);
	console.log(`workflow: ${doc.name ?? nameOrPath} (${doc.tasks.length} task${doc.tasks.length === 1 ? "" : "s"})`);
	const { failed } = await submitAndFollow(host, doc, follow);
	if (failed) process.exit(1);
}

/** Conventional locations for slash-command recipes, in precedence order. */
const COMMAND_DIRS = [join(".agents", "commands"), join(".claude", "commands")];

/**
 * A slash-command recipe discovered under `.agents/commands/` (or `.claude/`):
 * a single-agent task whose markdown body is the prompt and whose frontmatter
 * carries the metadata. These are the seam `workflow init` turns into named,
 * single-task workflows.
 */
export interface CommandFile {
	/** Command name (frontmatter `name`, else the filename without extension). */
	name: string;
	/** One-line summary (frontmatter `description`), used as the workflow goal/description. */
	description?: string;
	/** The markdown body below the frontmatter — becomes the task prompt. */
	body: string;
	/** Absolute path to the command's `.md` file. */
	file: string;
}

/** Strip a leading YAML frontmatter block, returning the trimmed markdown body. */
function stripFrontmatterBody(text: string): string {
	const match = text.match(/^---\n[\s\S]*?\n---\n?/);
	return (match ? text.slice(match[0].length) : text).trim();
}

/**
 * Scan the conventional command directories under `cwd` — both the hoocode
 * (`.agents/commands/`) and Claude (`.claude/commands/`) layouts — and return
 * the discovered recipes, deduplicated by name with `.agents/` winning over
 * `.claude/`. An empty result means there are no commands to convert.
 */
export function scanCommands(cwd = process.cwd()): CommandFile[] {
	const commands: CommandFile[] = [];
	const seen = new Set<string>();
	for (const rel of COMMAND_DIRS) {
		for (const file of listMarkdown(join(cwd, rel))) {
			const text = readFileSync(file, "utf-8");
			const meta = parseFrontmatter(text);
			const name = typeof meta.name === "string" ? meta.name : basename(file, extname(file));
			if (seen.has(name)) continue;
			seen.add(name);
			commands.push({
				name,
				description: typeof meta.description === "string" ? meta.description.trim() : undefined,
				body: stripFrontmatterBody(text),
				file,
			});
		}
	}
	return commands;
}

/**
 * Convert a single-agent command recipe into a named workflow document: one
 * task running the command body on `role`. The command's first description line
 * becomes the workflow goal/description so `workflow list` reads cleanly.
 */
export function commandToWorkflow(command: CommandFile, role: string): WorkflowDocument {
	const firstLine = command.description?.split("\n")[0]?.trim();
	return {
		name: command.name,
		description: firstLine || `Workflow generated from the "${command.name}" command.`,
		...(command.description ? { goal: command.description } : {}),
		tasks: [{ id: command.name, role, prompt: command.body }],
	};
}

/**
 * Pick the role generated workflows run on: the team's planner (it carries the
 * coding tools), else the first configured role, else "planner". Reads the
 * scaffolded team.json when present so generated workflows target real agents.
 */
function defaultWorkflowRole(cwd: string): string {
	try {
		const teamPath = join(cwd, ".agents", "teams", "team.json");
		if (existsSync(teamPath)) {
			const team = JSON.parse(readFileSync(teamPath, "utf-8")) as { team?: Array<{ role?: unknown; category?: unknown }> };
			const roles = Array.isArray(team.team) ? team.team : [];
			const planner = roles.find((r) => r.category === "plan");
			const named = planner ?? roles[0];
			if (named && typeof named.role === "string") return named.role;
		}
	} catch {
		// Unreadable/malformed team.json — fall back to the conventional default.
	}
	return "planner";
}

export interface WorkflowInitOptions {
	/** Overwrite workflow files that already exist. Default: skip them. */
	force?: boolean;
	/** Project root to scaffold into. Defaults to process.cwd(). */
	cwd?: string;
}

/**
 * Scaffold `.agents/workflows/` from the project's slash-command recipes: each
 * `.agents/commands/<name>.md` (or `.claude/commands/`) becomes a named,
 * single-task workflow that runs the command body on the team's planner role.
 * This is the first-level bridge — commands are single-agent recipes, so each
 * maps directly to a one-task graph that `hooteams workflow run <name>` invokes.
 * Existing workflow files are left untouched unless --force.
 */
export async function workflowInit(opts: WorkflowInitOptions = {}): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const commands = scanCommands(cwd);
	if (commands.length === 0) {
		console.log("no commands found in .agents/commands/ or .claude/commands/");
		console.log("add a command recipe (a .md file with a prompt body), then re-run: hooteams workflow init");
		return;
	}
	const role = defaultWorkflowRole(cwd);
	let wrote = 0;
	for (const command of commands) {
		const rel = join(WORKFLOWS_DIR, `${command.name}.json`);
		const abs = join(cwd, rel);
		const exists = existsSync(abs);
		if (exists && !opts.force) {
			console.log(`skip   ${rel} (exists)`);
			continue;
		}
		const doc = commandToWorkflow(command, role);
		await Bun.write(abs, `${JSON.stringify(doc, null, "\t")}\n`);
		console.log(`${exists ? "overwrote" : "created"}  ${rel}  ← ${command.name}`);
		wrote++;
	}
	if (wrote === 0) {
		console.log("\nNothing to do — all command workflows already exist (use --force to overwrite).");
		return;
	}
	console.log(`\nGenerated ${wrote} workflow(s) from commands, running on role "${role}".`);
	console.log("  Review them under .agents/workflows/, then: hooteams workflow run <name>");
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
	let defaults: { provider?: string; model?: string } = {};
	try {
		const cfg = await loadConfig(configPath);
		availableRoles = cfg.team;
		defaults = cfg.defaults ?? {};
	} catch (error) {
		console.error(`(planner) ignoring team config: ${error instanceof Error ? error.message : String(error)}`);
	}
	// CLI flags win; fall back to the team config's defaults.provider/model.
	const resolvedProvider = provider ?? defaults.provider;
	const resolvedModelId = modelId ?? defaults.model;
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
		// Carry the team's provider/model so dynamically-planned roles inherit the
		// configured provider instead of falling back to anthropic (R2-1), plus the
		// hoocode model tiers so a planner-chosen "fast"/"standard"/"capable"
		// resolves to a concrete, provider-correct id.
		roleDefaults: { provider: resolvedProvider, model: resolvedModelId, modelCategories: discoverModelCategories() },
		model: resolvedModelId ? resolveTeamModel(resolvedProvider ?? "anthropic", resolvedModelId) : undefined,
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

/**
 * A cheaper/faster model for the "quick" tier, keyed by the discovered provider.
 * Tiering the reviewer onto a smaller model is what the `quick` category signals;
 * unknown providers fall back to the default model (no tiering, but still valid).
 */
const QUICK_TIER_MODEL: Record<string, string> = {
	anthropic: "claude-haiku-4-5",
	openai: "gpt-5-mini",
};

/** The default goal validator scaffolded into team.json so every run self-checks. */
const SCAFFOLD_VALIDATOR =
	"You are a strict reviewer. Given the team's goal and every task's output, judge whether the goal was actually achieved — completed tasks alone do not prove it. Only declare success when the goal is genuinely met.";

/**
 * A hoocode/claude agent definition discovered on disk. Only the metadata
 * `init` needs is carried — the prompt body stays in the `.md` file and is
 * referenced by path (`file`), never inlined into team.json.
 */
export interface HoocodeAgent {
	/** Agent name (frontmatter `name`, else the filename without extension). */
	name: string;
	/** Optional team tier hint (frontmatter `category`): "plan" | "deep" | "quick". */
	category?: string;
	/** Optional model override (frontmatter `model`). */
	model?: string;
	/** Skill names this agent references (frontmatter `skills`), matched against discovered skills. */
	skills?: string[];
	/** Absolute path to the agent's `.md` file (becomes systemPromptFile). */
	file: string;
}

/** A skill `.md` file discovered on disk; referenced by path via skillFiles[]. */
export interface HoocodeSkill {
	/** Skill name (frontmatter `name`, else the filename without extension). */
	name: string;
	/** Absolute path to the skill's `.md` file. */
	file: string;
}

/** Conventional locations for agent definitions, in precedence order (first wins on name clash). */
const AGENT_DIRS = [join(".agents", "agents"), join(".claude", "agents")];
/** Conventional locations for skill definitions, in precedence order. */
const SKILL_DIRS = [join(".agents", "skills"), join(".claude", "skills")];

/**
 * Parse a markdown file's YAML frontmatter into a flat string/array record.
 * Only the scalar and simple-list fields `init` cares about (name, category,
 * model, skills) are extracted; anything fancier is ignored. Returns an empty
 * record when there's no frontmatter.
 */
function parseFrontmatter(text: string): Record<string, string | string[]> {
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	if (!match?.[1]) return {};
	const out: Record<string, string | string[]> = {};
	const lines = match[1].split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!kv?.[1]) continue;
		const key = kv[1];
		const value = (kv[2] ?? "").trim();
		if (value === "" || value === "|" || value === ">") {
			// A YAML list (indented `- item` lines) or a block scalar (`|`/`>`,
			// then more-indented continuation lines). Lists win when present.
			const items: string[] = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1] ?? "")) {
				items.push((lines[++i] ?? "").replace(/^\s*-\s+/, "").trim());
			}
			if (items.length > 0) {
				out[key] = items;
				continue;
			}
			// Block scalar: gather indented continuation lines, joined with the
			// folding (`>`) or literal (`|`) newline convention.
			const block: string[] = [];
			while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) {
				block.push((lines[++i] ?? "").replace(/^\s+/, ""));
			}
			if (block.length > 0) out[key] = block.join(value === ">" ? " " : "\n");
			continue;
		}
		// Inline flow list: [a, b, c]
		const flow = value.match(/^\[(.*)\]$/);
		if (flow?.[1] !== undefined) {
			out[key] = flow[1]
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
			continue;
		}
		out[key] = value.replace(/^["']|["']$/g, "");
	}
	return out;
}

/** List `*.md` files in a directory (non-recursive), or [] if it doesn't exist. */
function listMarkdown(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => extname(f) === ".md")
		.map((f) => join(dir, f));
}

/**
 * Scan the conventional agent/skill directories under `cwd` — both the hoocode
 * (`.agents/`) and Claude (`.claude/`) layouts — and return the discovered
 * definitions. Agents/skills are deduplicated by name with `.agents/` winning
 * over `.claude/`. Only metadata is returned; prompt bodies stay in their files
 * and are referenced by path. An empty result means no agents were found and
 * `init` should fall back to the generic inline scaffold.
 */
export function scanHoocodeAgents(cwd: string): { agents: HoocodeAgent[]; skills: HoocodeSkill[] } {
	const agents: HoocodeAgent[] = [];
	const seenAgents = new Set<string>();
	for (const rel of AGENT_DIRS) {
		for (const file of listMarkdown(join(cwd, rel))) {
			const meta = parseFrontmatter(readFileSync(file, "utf-8"));
			const name = typeof meta.name === "string" ? meta.name : basename(file, extname(file));
			if (seenAgents.has(name)) continue;
			seenAgents.add(name);
			agents.push({
				name,
				file,
				category: typeof meta.category === "string" ? meta.category : undefined,
				model: typeof meta.model === "string" ? meta.model : undefined,
				skills: Array.isArray(meta.skills) ? meta.skills : typeof meta.skills === "string" ? [meta.skills] : undefined,
			});
		}
	}

	const skills: HoocodeSkill[] = [];
	const seenSkills = new Set<string>();
	for (const rel of SKILL_DIRS) {
		for (const file of listMarkdown(join(cwd, rel))) {
			const meta = parseFrontmatter(readFileSync(file, "utf-8"));
			const name = typeof meta.name === "string" ? meta.name : basename(file, extname(file));
			if (seenSkills.has(name)) continue;
			seenSkills.add(name);
			skills.push({ name, file });
		}
	}

	return { agents, skills };
}

/** Where the scaffolded team.json lives, relative to the project root. */
const TEAM_JSON_PATH = join(".agents", "teams", "team.json");

/**
 * Render the scaffold team.json, wiring in the discovered hoocode model
 * defaults. When agent definitions are discovered on disk, each team role
 * *references* its `.md` file by path (`systemPromptFile`) and its skills by
 * path (`skillFiles`) — edits to those files take effect on the next run with
 * no re-init. Without discovered agents, the generic inline scaffold is written.
 */
function buildTeamJson(cwd: string, scan?: { agents: HoocodeAgent[]; skills: HoocodeSkill[] }): string {
	const defaults = discoverHoocodeDefaults();
	// Tier the cheap "quick" role down when we know a smaller model for the provider;
	// otherwise leave it on the default model so the config stays valid for any provider.
	const quickModel = QUICK_TIER_MODEL[defaults.provider];
	const team =
		scan && scan.agents.length > 0
			? buildReferencedTeam(cwd, scan)
			: [
					// The planner gets the coding tools so it can read the repo while planning,
					// instead of breaking the goal down blind.
					{ role: "planner", category: "plan", defaultTools: true, systemPrompt: "You are the planner. Break the goal into tasks and coordinate the team." },
					{ role: "coder", category: "deep", defaultTools: true, systemPrompt: "You are the coder. Implement tasks one at a time, with tests." },
					{
						role: "reviewer",
						category: "quick",
						defaultTools: true,
						// Tiered onto a cheaper model when one is known for the provider.
						...(quickModel ? { model: quickModel } : {}),
						systemPrompt: "You are the reviewer. Check the work against the goal and flag gaps.",
					},
				];
	return `${JSON.stringify(
		{
			defaults,
			maxConcurrent: 3,
			rulesDir: ".agents/teams/rules",
			validator: SCAFFOLD_VALIDATOR,
			team,
		},
		null,
		"\t",
	)}\n`;
}

/**
 * Turn discovered agents/skills into team roles that reference their source
 * `.md` files by path. Paths are written relative to the team.json directory so
 * the resolved config (and the relative refs) stay portable across machines. An
 * agent's `skills` frontmatter is matched against discovered skills by name.
 */
function buildReferencedTeam(cwd: string, scan: { agents: HoocodeAgent[]; skills: HoocodeSkill[] }): Array<Record<string, unknown>> {
	const teamDir = join(cwd, TEAM_JSON_PATH, "..");
	const toRef = (absFile: string): string => relative(teamDir, absFile).split("\\").join("/");
	const skillByName = new Map(scan.skills.map((s) => [s.name, s] as const));
	return scan.agents.map((agent) => {
		const skillFiles = (agent.skills ?? [])
			.map((name) => skillByName.get(name))
			.filter((s): s is HoocodeSkill => s !== undefined)
			.map((s) => toRef(s.file));
		return {
			role: agent.name,
			...(agent.category ? { category: agent.category } : {}),
			defaultTools: true,
			...(agent.model ? { model: agent.model } : {}),
			systemPromptFile: toRef(agent.file),
			...(skillFiles.length > 0 ? { skillFiles } : {}),
		};
	});
}

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
- Agent definitions: \`.agents/agents/*.md\` or \`.claude/agents/*.md\` (referenced via \`systemPromptFile\`)
- Skills: \`.agents/skills/*.md\` or \`.claude/skills/*.md\` (referenced via \`skillFiles[]\`)
- Workflows: \`.agents/workflows/*.json\` (static task graphs; \`hooteams workflow run <name>\`)
- Project rules: \`.agents/teams/rules/\`

Agent prompts are composed at runtime: the \`.md\` file body becomes the system
prompt, and each listed skill's body is appended automatically. To update an
agent's behavior, edit \`.agents/agents/<name>.md\` directly — no need to re-run
\`hooteams init\`.

Describe the project, its conventions, and anything every agent must know.
`;

/**
 * Render a starter workflow: a named, static task graph wired to the team's
 * roles. Workflows bypass the planner — `hooteams workflow run example` submits
 * this graph verbatim. The roles are taken from the scaffolded team so the
 * example runs against whatever agents were discovered (or the generic trio).
 */
function buildWorkflowJson(roles: string[]): string {
	const plannerRole = roles[0] ?? "planner";
	const builderRole = roles[1] ?? roles[0] ?? "coder";
	const reviewerRole = roles[2] ?? roles[1] ?? roles[0] ?? "reviewer";
	return `${JSON.stringify(
		{
			name: "example",
			description: "A static plan/build/review pipeline — edit the prompts and deps to fit your project.",
			goal: "Describe what this workflow should accomplish.",
			tasks: [
				{ id: "plan", role: plannerRole, prompt: "Break the goal into concrete steps." },
				{ id: "build", role: builderRole, prompt: "Implement the planned steps.", deps: ["plan"] },
				{ id: "review", role: reviewerRole, prompt: "Review the work against the goal.", deps: ["build"] },
			],
		},
		null,
		"\t",
	)}\n`;
}

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
 *
 * When agent definitions are discovered on disk (the hoocode `.agents/agents/`
 * or Claude `.claude/agents/` layouts, with matching `skills/` dirs), the
 * scaffolded team.json *references* those `.md` files by path instead of
 * inlining prompts — so editing an agent file takes effect on the next run with
 * no re-init.
 */
export async function init(opts: InitOptions = {}): Promise<void> {
	const cwd = opts.cwd ?? process.cwd();
	const scan = scanHoocodeAgents(cwd);
	// The starter workflow targets the scaffolded team's roles: discovered agent
	// names when present, else the generic planner/coder/reviewer trio.
	const roleNames = scan.agents.length > 0 ? scan.agents.map((a) => a.name) : ["planner", "coder", "reviewer"];
	const files: ScaffoldFile[] = [
		{ path: join(".agents", "teams", "team.json"), content: buildTeamJson(cwd, scan) },
		{ path: join(".agents", "teams", "rules", "00-style.md"), content: STYLE_RULE },
		{ path: join(".agents", "teams", "rules", "AGENTS.md"), content: AGENTS_STUB },
		{ path: join(".agents", "workflows", "example.json"), content: buildWorkflowJson(roleNames) },
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
	if (wrote === 0) {
		console.log("\nNothing to do — all scaffold files already exist (use --force to overwrite).");
		return;
	}
	console.log(`\nScaffolded ${wrote} file(s).`);
	if (scan.agents.length > 0) {
		console.log(`  Source: ${scan.agents.length} agent(s) referenced by path, with ${scan.skills.length} skill(s) discovered.`);
		console.log("  Agents/skills are referenced by path — edit them directly, no need to re-run init.");
	}
	console.log('  Next: edit .agents/teams/team.json, then: hooteams work "<goal>"');
	console.log("  Or run the starter pipeline: hooteams workflow run example");
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
 * Cancel the server's active run without killing the server: aborts live
 * agents, fails the unfinished tasks, and settles the run as failed (completed
 * tasks keep their output). The web UI and server stay up, ready for the next
 * run — unlike `hooteams stop`, which tears the whole server down.
 */
export async function cancel(host: string): Promise<void> {
	const response = await fetch(`${host}/runs/cancel`, { method: "POST" });
	if (response.status === 404) {
		console.log("no active run to cancel");
		return;
	}
	if (response.status === 409) {
		console.log("run already finished");
		return;
	}
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(error.error ?? `HTTP ${response.status}`);
	}
	const { runId } = (await response.json()) as { runId: string };
	console.log(`cancelled run ${runId} ✓`);
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
