import { createRouter, type HitlRun, RunRejectedError, SSEBridge, type StartRunRequest, type StartRunTask } from "@kolisachint/hooteams-bridge";
import {
	createAskAgentTool,
	createHoocodeAuth,
	createMemoryReadTool,
	createMemoryWriteTool,
	createNodeHarnessFactory,
	createValidatorAgent,
	JsonlSessionRepo,
	PLANNER_ROLE,
	type RoleConfig,
	type RunMemory,
	type Session,
	TaskDag,
	type TaskNode,
	Team,
	TeamChannel,
	TeamMemory,
	TeamOrchestrator,
	type TeamOptions,
} from "@kolisachint/hooteams-orchestrator";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PORT, type ServerConfig } from "./config.js";

export interface RunningServer {
	server: ReturnType<typeof Bun.serve>;
	channel: TeamChannel;
	team: Team;
	bridge: SSEBridge;
	port: number;
	/**
	 * Expose a live TeamOrchestrator run on the HITL routes (/tasks/pending,
	 * /tasks/:id/resume, /trace). The session is the orchestrator's run
	 * session, read by the trace route. Attaching replaces any previous run;
	 * the routes 404 until the first attach. POST /runs does this wiring
	 * itself — this hook is for embedders driving their own orchestrator.
	 */
	attachOrchestrator(orchestrator: TeamOrchestrator, session: Session): void;
	/** Abort all agents, drop SSE clients, and stop listening. */
	stop(): Promise<void>;
}

export interface StartOptions {
	port?: number;
	/** Forwarded to the Team (tests inject fake models / stream functions). */
	teamOptions?: TeamOptions;
	/** Overrides config.sessionsRoot (tests point this at a temp dir). */
	sessionsRoot?: string;
	/** Overrides config.memoryRoot (tests point this at a temp dir). */
	memoryRoot?: string;
	/** Overrides config.resumeInterrupted. */
	resumeInterrupted?: boolean;
	/** Overrides config.allowAutonomous. When false (default), HITL completion gate is active. */
	allowAutonomous?: boolean;
}

export function startServer(config: ServerConfig, options: StartOptions = {}): RunningServer {
	const channel = new TeamChannel();
	// Credentials come from hoocode's store (~/.hoocode/auth.json, then env
	// vars) unless the caller injects its own resolver (tests, embedders).
	const teamOptions: TeamOptions = {
		getApiKey: createHoocodeAuth(),
		...options.teamOptions,
	};
	const team = new Team(channel, teamOptions);
	const bridge = new SSEBridge(channel);

	// HITL is the product default: the completion gate is active unless the CLI
	// flag or config opts into autonomous runs (CLI wins over config).
	const allowAutonomous = options.allowAutonomous ?? config.allowAutonomous ?? false;
	const sessionsRoot = options.sessionsRoot ?? config.sessionsRoot ?? join(homedir(), ".hooteams", "sessions");
	const repo = new JsonlSessionRepo({ sessionsRoot });
	// Cross-run shared memory, scoped to the project (not the run): task
	// outputs are auto-recorded at run end, new runs bootstrap from prior ones,
	// and every agent gets memory_read/memory_write. Disable with memory: false.
	const memory =
		config.memory !== false
			? new TeamMemory({ memoryRoot: options.memoryRoot ?? config.memoryRoot, project: config.project })
			: undefined;
	const runMemoryFor = async (): Promise<RunMemory | undefined> =>
		memory
			? {
					bootstrapContext: await memory.bootstrapContext(),
					recordTask: (task) => memory.recordTask(task),
				}
			: undefined;
	// Run sessions are keyed by a stable cwd so a restarted server (possibly
	// launched from another directory) still finds them for restore/trace.
	const runsCwd = sessionsRoot;

	let activeRun: HitlRun | undefined;
	let activeOrchestrator: TeamOrchestrator | undefined;
	const attachOrchestrator = (orchestrator: TeamOrchestrator, session: Session): void => {
		activeOrchestrator = orchestrator;
		activeRun = {
			runId: orchestrator.runId,
			resume: (taskId, chosenOption, feedback) => orchestrator.resume(taskId, chosenOption, feedback),
			pendingApprovals: () => orchestrator.pendingApprovals(),
			trace: (runId) => TeamOrchestrator.buildTrace(session, runId),
		};
	};

	/** Configured team plus any per-run roles; configured roles win on a name clash. */
	const mergeRoles = (extraRoles: RoleConfig[] = []): RoleConfig[] => {
		const configured = new Set(config.team.map((role) => role.role));
		return [...config.team, ...extraRoles.filter((role) => !configured.has(role.role))];
	};

	// A permanently failed task (retries exhausted) is steered to the planner
	// agent, when one is configured, for structural recovery: it can spawn a
	// specialist with spawn_agent or re-delegate with delegate_task.
	const escalateFailure = (node: TaskNode, error: string): void => {
		if (!team.has(PLANNER_ROLE)) return;
		team.steer(
			PLANNER_ROLE,
			`Task "${node.id}" (role "${node.role}") failed permanently after ${(node.attempts ?? 0) + 1} attempt(s): ${error}\n` +
				"Review the failure and recover the goal — e.g. spawn a recovery specialist with spawn_agent or re-delegate with delegate_task.",
		);
	};

	// Goal validation reviews every cleanly completed run when the config sets
	// a validator prompt; the validator runs on defaults.model or the first
	// team role's model.
	const validatorModel = config.defaults?.model ?? config.team[0]?.model;
	const validatorFor = (goal?: string) =>
		config.validator && validatorModel
			? {
					goal,
					validate: createValidatorAgent({
						systemPrompt: config.validator,
						model: validatorModel,
						provider: config.defaults?.provider,
						getApiKey: teamOptions.getApiKey,
						resolveModel: teamOptions.resolveModel,
						streamFn: teamOptions.streamFn,
					}),
				}
			: undefined;

	const orchestratorOptions = (runId: string, tasks: StartRunTask[], goal?: string, extraRoles?: RoleConfig[], runMemory?: RunMemory) => {
		const prompts = new Map(tasks.filter((task) => task.prompt).map((task) => [task.id, task.prompt!]));
		return {
			channel,
			runId,
			maxConcurrent: config.maxConcurrent,
			createHarness: createNodeHarnessFactory({
				roles: mergeRoles(extraRoles),
				runId,
				sessionsRoot,
				getApiKey: teamOptions.getApiKey,
				resolveModel: teamOptions.resolveModel,
				streamFn: teamOptions.streamFn,
				team, // Pass team to enable the delegate_task/ask_agent messaging tools
				memory, // Pass shared memory to enable the memory_read/memory_write tools
			}),
			taskPrompt: (node: { id: string }) => prompts.get(node.id) ?? node.id,
			allowAutonomous,
			onTaskFailed: escalateFailure,
			validator: validatorFor(goal),
			memory: runMemory,
		};
	};

	const startRun = async (request: StartRunRequest): Promise<{ runId: string }> => {
		if (activeOrchestrator && !activeOrchestrator.isSettled) {
			throw new RunRejectedError(`Run "${activeOrchestrator.runId}" is still active`, 409);
		}
		const roles = new Set(mergeRoles(request.roles).map((role) => role.role));
		const dag = new TaskDag();
		try {
			for (const task of request.tasks) {
				if (!roles.has(task.role)) {
					const available = [...roles];
					throw new Error(
						`Unknown role "${task.role}". Configured roles: ${available.length > 0 ? available.join(", ") : "(none)"}`,
					);
				}
				dag.add({ id: task.id, role: task.role, deps: task.deps, retries: task.retries, gate: task.gate, advisor: task.advisor });
			}
			dag.topologicalOrder(); // throws on unknown deps and cycles
		} catch (err) {
			throw new RunRejectedError(err instanceof Error ? err.message : String(err), 400);
		}
		const runId = randomUUID();
		const session = await repo.create({ cwd: runsCwd, id: `run-${runId}` });
		// Task prompts, goal, and per-run roles live only in this request;
		// persist them so a restored run re-dispatches with the real config.
		await session.appendCustomEntry("run_config", { runId, tasks: request.tasks, goal: request.goal, roles: request.roles });
		const orchestrator = new TeamOrchestrator(dag, {
			session,
			...orchestratorOptions(runId, request.tasks, request.goal, request.roles, await runMemoryFor()),
		});
		attachOrchestrator(orchestrator, session);
		void orchestrator.run();
		return { runId };
	};

	/** Reattach the newest unfinished run session and continue driving it. */
	const restoreInterruptedRun = async (): Promise<void> => {
		const newestFirst = (await repo.list({ cwd: runsCwd }))
			.filter((metadata) => metadata.id.startsWith("run-"))
			.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
		const latest = newestFirst[0];
		if (!latest) return;
		const session = await repo.open(latest);
		let runId: string | undefined;
		let tasks: StartRunTask[] = [];
		let goal: string | undefined;
		let runRoles: RoleConfig[] | undefined;
		let ended = false;
		for (const entry of await session.getEntries()) {
			if (entry.type !== "custom") continue;
			const data = entry.data as Record<string, any> | undefined;
			if (entry.customType === "run_config") {
				runId ??= data?.runId;
				tasks = (data?.tasks as StartRunTask[] | undefined) ?? [];
				goal = data?.goal;
				runRoles = data?.roles as RoleConfig[] | undefined;
			} else if (entry.customType === "run_start") {
				runId ??= data?.runId;
			} else if (entry.customType === "run_end") {
				ended = true;
			}
		}
		if (!runId || ended) return;
		const orchestrator = await TeamOrchestrator.restoreFromSession(
			session,
			orchestratorOptions(runId, tasks, goal, runRoles, await runMemoryFor()),
		);
		attachOrchestrator(orchestrator, session);
		console.log(`[hooteams] restored interrupted run ${runId}`);
		void orchestrator.run();
	};

	const router = createRouter(team, channel, bridge, { hitl: () => activeRun, startRun });

	// Config-spawned agents get the team-collaboration tools on top of their
	// own: ask_agent for request-response messaging, and (when memory is on)
	// the shared cross-run memory tools.
	const withCollaborationTools = (role: RoleConfig): RoleConfig => ({
		...role,
		tools: [
			...(role.tools ?? []),
			createAskAgentTool(team, { selfRole: role.role }),
			...(memory ? [createMemoryReadTool(memory), createMemoryWriteTool(memory, { role: role.role })] : []),
		],
	});

	for (const role of config.team) {
		if (role.mcpConfigPath) {
			// MCP loading is async; spawn in the background so startup stays sync.
			// A failed role is logged and skipped instead of taking the server down.
			void team.spawnAsync(withCollaborationTools(role)).catch((error) => {
				console.error(`[hooteams] failed to spawn role "${role.role}": ${String(error)}`);
			});
		} else {
			team.spawn(withCollaborationTools(role));
		}
	}

	if (options.resumeInterrupted ?? config.resumeInterrupted) {
		void restoreInterruptedRun().catch((error) => {
			console.error(`[hooteams] failed to restore interrupted run: ${String(error)}`);
		});
	}

	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await team.killAll();
		bridge.closeAll();
		server.stop(true);
	};

	const server = Bun.serve({
		port: options.port ?? config.port ?? Number(process.env.PORT ?? DEFAULT_PORT),
		// SSE clients (/events) hold the connection open indefinitely; Bun's
		// default 10s idleTimeout would kill them whenever the team goes quiet.
		idleTimeout: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/stop") {
				// stop(true) force-closes every connection including this one,
				// so give the response a moment to flush before shutting down.
				setTimeout(() => void stop(), 100);
				return Response.json({ ok: true, stopping: true });
			}
			return router.fetch(request);
		},
	});

	return { server, channel, team, bridge, port: server.port ?? 0, attachOrchestrator, stop };
}
