import { Agent, type AgentTool, type StreamFn } from "@kolisachint/hoocode-agent-core";
import { getModel, type Model, Type } from "@kolisachint/hoocode-ai";
import { randomUUID } from "node:crypto";
import type { TaskDag } from "./dag.js";
import type { Team } from "./team.js";
import type { RoleConfig, ThinkingLevel } from "./types.js";

const spawnAgentParams = Type.Object({
	role: Type.String({ description: "Unique role name for the new agent, e.g. coder, tester" }),
	systemPrompt: Type.String({ description: "System prompt defining the agent's responsibilities" }),
	model: Type.String({ description: "Model id the agent should use, e.g. claude-sonnet-4-5" }),
	provider: Type.Optional(Type.String({ description: "Model provider, defaults to anthropic" })),
	task: Type.Optional(Type.String({ description: "If given, immediately prompt the new agent with this task" })),
	taskId: Type.Optional(
		Type.String({
			description: "Task id to register this worker under in the team's task DAG, so progress is tracked by task rather than role",
		}),
	),
	deps: Type.Optional(
		Type.Array(Type.String(), {
			description: "Ids of tasks that must finish before this agent's task starts; their outputs are passed into its prompt",
		}),
	),
	retries: Type.Optional(
		Type.Number({ description: "Extra attempts the task gets if its run fails, before the failure is escalated" }),
	),
	defaultTools: Type.Optional(
		Type.Boolean({
			description: "Give the agent hoocode's built-in coding tools (bash/read/edit/write/grep/find/ls)",
		}),
	),
	mcpConfigPath: Type.Optional(
		Type.String({ description: "Path to an mcp.json file; the agent also gets the tools of its MCP servers" }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent's tools" })),
});

/**
 * Tool handed to the planner agent so it can grow the team itself.
 * Spawning awaits tool assembly (MCP servers included); an optional initial
 * task runs detached so the planner keeps reasoning while the worker starts.
 * When a dag is supplied, a taskId param registers the worker's task in it so
 * the orchestrator tracks the worker by task id, not just role.
 */
export function createSpawnAgentTool(team: Team, dag?: TaskDag): AgentTool<typeof spawnAgentParams> {
	return {
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a new team agent with the given role, system prompt, and model. " +
			"Set defaultTools to equip it with the built-in coding tools, mcpConfigPath to add MCP server tools, " +
			"and cwd to pick its working directory. " +
			"Optionally give it an initial task to start working on immediately, " +
			"and a taskId to register that task in the team's task DAG.",
		parameters: spawnAgentParams,
		execute: async (_toolCallId, params) => {
			const config: RoleConfig = {
				role: params.role,
				systemPrompt: params.systemPrompt,
				model: params.model,
				provider: params.provider,
				defaultTools: params.defaultTools,
				mcpConfigPath: params.mcpConfigPath,
				cwd: params.cwd,
			};
			const agent = await team.spawnAsync(config);
			if (dag && params.taskId && !dag.get(params.taskId)) {
				dag.add({ id: params.taskId, role: params.role, deps: params.deps, retries: params.retries });
			}
			if (params.task) {
				if (dag && params.taskId) {
					dag.markRunning(params.taskId);
				}
				void agent.prompt(params.task).catch(() => {});
			}
			const toolCount = agent.state.tools.length;
			const toolNote = toolCount > 0 ? ` with ${toolCount} tools` : "";
			const note = params.task ? ` and started on its first task` : "";
			return {
				content: [{ type: "text", text: `Spawned agent "${params.role}" (${params.model})${toolNote}${note}.` }],
				details: {
					role: params.role,
					model: params.model,
					tools: toolCount,
					started: Boolean(params.task),
					taskId: params.taskId,
				},
			};
		},
	};
}

const delegateTaskParams = Type.Object({
	role: Type.String({ description: "Role of the existing team member to hand the task to" }),
	task: Type.String({ description: "The task or instruction to send to that agent" }),
});

/**
 * Tool that lets any agent hand off a subtask to a named team member.
 * Delegation is fire-and-forget: the task is steered into the target agent
 * (starting a run if it is idle) and the caller keeps working.
 */
export function createDelegateTaskTool(team: Team): AgentTool<typeof delegateTaskParams> {
	return {
		name: "delegate_task",
		label: "Delegate Task",
		description:
			"Hand off a task to an existing team member by role. Mid-run the task is queued as a " +
			"steering message; an idle agent starts a new run on it.",
		parameters: delegateTaskParams,
		execute: async (_toolCallId, params) => {
			if (!team.has(params.role)) {
				const roles = team.roles();
				throw new Error(
					`No agent for role "${params.role}". Available roles: ${roles.length > 0 ? roles.join(", ") : "(none — spawn one first)"}`,
				);
			}
			team.steer(params.role, params.task);
			return {
				content: [{ type: "text", text: `Delegated task to "${params.role}".` }],
				details: { role: params.role },
			};
		},
	};
}

/** One task of a dry-run plan, shaped like a POST /runs task (and tasks.json). */
export interface PlannedTask {
	id: string;
	role: string;
	prompt?: string;
	deps?: string[];
	retries?: number;
}

/**
 * What a dry-run planning pass produces: the role configs the planner would
 * have spawned and the task graph it would have dispatched. Serializable as a
 * tasks.json that `hooteams run` accepts directly.
 */
export interface PlanBuffer {
	roles: RoleConfig[];
	tasks: PlannedTask[];
}

/** A task id not yet used in the buffer, derived from the preferred id. */
function freeTaskId(buffer: PlanBuffer, preferred: string): string {
	if (!buffer.tasks.some((task) => task.id === preferred)) return preferred;
	let n = 2;
	while (buffer.tasks.some((task) => task.id === `${preferred}-${n}`)) n++;
	return `${preferred}-${n}`;
}

/**
 * Dry-run twin of createSpawnAgentTool: records the role config and task in
 * the plan buffer instead of spawning anything, so the plan can be inspected
 * (and approved) before a single agent runs.
 */
export function createPlanSpawnAgentTool(buffer: PlanBuffer): AgentTool<typeof spawnAgentParams> {
	return {
		name: "spawn_agent",
		label: "Plan Agent",
		description:
			"Record a new team agent in the plan: role, system prompt, model, and optionally its first task. " +
			"Nothing is spawned — this is a dry run. Give every task a taskId, a concrete task, and deps listing " +
			"the task ids whose results it needs.",
		parameters: spawnAgentParams,
		execute: async (_toolCallId, params) => {
			if (!buffer.roles.some((role) => role.role === params.role)) {
				buffer.roles.push({
					role: params.role,
					systemPrompt: params.systemPrompt,
					model: params.model,
					provider: params.provider,
					defaultTools: params.defaultTools,
					mcpConfigPath: params.mcpConfigPath,
					cwd: params.cwd,
				});
			}
			let taskId: string | undefined;
			if (params.task || params.taskId) {
				taskId = freeTaskId(buffer, params.taskId ?? params.role);
				buffer.tasks.push({ id: taskId, role: params.role, prompt: params.task, deps: params.deps, retries: params.retries });
			}
			const note = taskId ? ` with task "${taskId}"` : "";
			return {
				content: [{ type: "text", text: `Planned agent "${params.role}" (${params.model})${note}. Nothing was spawned (dry run).` }],
				details: { role: params.role, model: params.model, taskId, dryRun: true },
			};
		},
	};
}

/** Dry-run twin of createDelegateTaskTool: appends a task for an already-planned role. */
export function createPlanDelegateTaskTool(buffer: PlanBuffer): AgentTool<typeof delegateTaskParams> {
	return {
		name: "delegate_task",
		label: "Plan Task",
		description:
			"Record an extra task for a role already in the plan. Nothing runs — this is a dry run. " +
			"Prefer spawn_agent with taskId/deps so the task's dependencies are explicit.",
		parameters: delegateTaskParams,
		execute: async (_toolCallId, params) => {
			if (!buffer.roles.some((role) => role.role === params.role)) {
				const roles = buffer.roles.map((role) => role.role);
				throw new Error(
					`No planned agent for role "${params.role}". Planned roles: ${roles.length > 0 ? roles.join(", ") : "(none — plan one with spawn_agent first)"}`,
				);
			}
			const taskId = freeTaskId(buffer, params.role);
			buffer.tasks.push({ id: taskId, role: params.role, prompt: params.task });
			return {
				content: [{ type: "text", text: `Planned task "${taskId}" for "${params.role}" (dry run).` }],
				details: { role: params.role, taskId, dryRun: true },
			};
		},
	};
}

export interface PlannerOptions {
	team: Team;
	systemPrompt?: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	streamFn?: StreamFn;
	/** Resolves provider credentials per request, e.g. createHoocodeAuth(). */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Extra tools beyond spawn_agent. */
	tools?: AgentTool<any>[];
	/**
	 * Plan without executing: spawn_agent and delegate_task write to
	 * `planBuffer` instead of touching the team, so the plan can be inspected
	 * (and run later via tasks.json / POST /runs) before any agent starts.
	 */
	dryRun?: boolean;
}

const DEFAULT_PLANNER_PROMPT = `You are the planner of a team of AI agents.
Break the user's goal into tasks, spawn specialist agents with the spawn_agent tool,
and give each a focused system prompt and an initial task. Keep roles small and composable.
Workers that must touch code or run commands need tools: pass defaultTools: true for the
built-in coding tools (bash/read/edit/write/grep/find/ls), cwd to set their working
directory, and mcpConfigPath to add tools from an mcp.json file.`;

const DRY_RUN_ADDENDUM = `

You are in planning mode: spawn_agent and delegate_task record a plan instead of starting
agents — nothing executes. Cover the whole goal. Give every agent a taskId, a concrete
task, and deps listing the task ids whose results it needs; add retries for tasks likely
to be flaky. When the plan covers the goal, summarize it briefly and stop.`;

export const PLANNER_ROLE = "planner";

/**
 * The orchestrator agent. It is itself a team member (role "planner") so its
 * thinking and tool calls stream over the same channel as its workers'.
 */
export class Planner {
	readonly agent: Agent;
	/** Where a dryRun planner's plan accumulates; undefined in live mode. */
	readonly planBuffer?: PlanBuffer;

	constructor(options: PlannerOptions) {
		const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
		if (options.dryRun) {
			this.planBuffer = { roles: [], tasks: [] };
		}
		const teamTools = this.planBuffer
			? [createPlanSpawnAgentTool(this.planBuffer), createPlanDelegateTaskTool(this.planBuffer)]
			: [createSpawnAgentTool(options.team), createDelegateTaskTool(options.team)];
		this.agent = new Agent({
			initialState: {
				systemPrompt: (options.systemPrompt ?? DEFAULT_PLANNER_PROMPT) + (options.dryRun ? DRY_RUN_ADDENDUM : ""),
				model,
				thinkingLevel: options.thinkingLevel ?? "off",
				tools: [...teamTools, ...(options.tools ?? [])],
			},
			streamFn: options.streamFn,
			getApiKey: options.getApiKey,
		});
		options.team.channel.attach(PLANNER_ROLE, randomUUID(), this.agent);
	}

	/** Run the planner against a goal. Resolves when the planning run settles. */
	async plan(goal: string): Promise<void> {
		await this.agent.prompt(goal);
	}
}
