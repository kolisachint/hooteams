import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@kolisachint/hoocode-agent-core";
import { type Model, Type } from "@kolisachint/hoocode-ai";
import { randomUUID } from "node:crypto";
import type { TaskDag } from "@kolisachint/hooteams-dag";
import { resolveTeamModel } from "./auth.js";
import { createMemoryReadTool, createMemoryWriteTool, type TeamMemory } from "./memory.js";
import type { Team } from "./team.js";
import { extractMessageText } from "./team-orchestrator.js";
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

const askAgentParams = Type.Object({
	role: Type.String({ description: "Role of the team member to ask" }),
	question: Type.String({ description: "The question; the agent's next completed reply is returned as the answer" }),
	timeoutSeconds: Type.Optional(Type.Number({ description: "How long to wait for the answer. Default 120" })),
});

export interface AskAgentOptions {
	/**
	 * Role of the asking agent. Asking your own role is rejected: the answer
	 * could never arrive while this run blocks waiting for it.
	 */
	selfRole?: string;
	/** Default seconds to wait for the target's reply. Default 120. */
	defaultTimeoutSeconds?: number;
}

/** The reply that followed our steered question, or why none could be returned. */
type AnswerLookup = { kind: "answer"; text: string } | { kind: "error"; error: string } | undefined;

/**
 * Request-response messaging between agents: steer `question` into the agent
 * registered under `role` and resolve with the reply to *that question*. The
 * answer is correlated by transcript position — the first assistant message
 * after our own steered user message — not merely the target's next agent_end,
 * so an unrelated run of the same agent that happens to settle first cannot
 * resolve us with the wrong content. Each agent_end (and team_error) for the
 * role re-checks the transcript; we settle only once our reply is present.
 * Rejects on a team_error before our answer lands, or on timeout. Pass
 * timeoutMs 0 to wait indefinitely.
 */
export function askAgent(team: Team, role: string, question: string, timeoutMs = 120_000): Promise<string> {
	const agent = team.get(role);
	if (!agent) {
		return Promise.reject(new Error(`No agent for role "${role}"`));
	}
	// Snapshot the log length now so we only consider messages added after we ask.
	const baseline = agent.state.messages.length;
	const findAnswer = (): AnswerLookup => {
		const messages = agent.state.messages as AgentMessage[];
		for (let i = baseline; i < messages.length; i++) {
			const message = messages[i]!;
			if (message.role !== "user" || !extractMessageText(message).includes(question)) continue;
			for (let j = messages.length - 1; j > i; j--) {
				const reply = messages[j]!;
				if (reply.role !== "assistant") continue;
				const errorMessage = (reply as { errorMessage?: string }).errorMessage;
				return errorMessage ? { kind: "error", error: errorMessage } : { kind: "answer", text: extractMessageText(reply) };
			}
			return undefined; // our question is in the log but has no reply yet
		}
		return undefined; // our question has not been processed yet
	};
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe = () => {};
		const settle = (apply: () => void): void => {
			if (settled) return;
			settled = true;
			unsubscribe();
			if (timer !== undefined) clearTimeout(timer);
			apply();
		};
		const tryResolve = (found: AnswerLookup): void => {
			if (!found) return;
			if (found.kind === "error") settle(() => reject(new Error(`Agent "${role}" failed while answering: ${found.error}`)));
			else settle(() => resolve(found.text));
		};
		// Subscribe before steering so a reply that lands immediately can't be missed.
		unsubscribe = team.channel.subscribe((event) => {
			if (event.type === "agent_end") {
				// A run ended — resolve only if it was the one that answered us.
				tryResolve(findAnswer());
			} else if (event.type === "team_error") {
				// Tolerate an unrelated failure if our answer already landed.
				const found = findAnswer();
				if (found?.kind === "answer") settle(() => resolve(found.text));
				else settle(() => reject(new Error(`Agent "${role}" failed while answering: ${event.error}`)));
			}
		}, role);
		if (timeoutMs > 0) {
			timer = setTimeout(
				() => settle(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for "${role}" to answer`))),
				timeoutMs,
			);
		}
		try {
			team.steer(role, question);
		} catch (err) {
			settle(() => reject(err instanceof Error ? err : new Error(String(err))));
		}
	});
}

/**
 * Tool that lets an agent ask a named team member a question and wait for the
 * answer — the request-response counterpart to fire-and-forget delegate_task.
 * The caller's run blocks inside the tool call until the target's next
 * agent_end fires, so the answer is in hand before the caller continues.
 */
export function createAskAgentTool(team: Team, options: AskAgentOptions = {}): AgentTool<typeof askAgentParams> {
	return {
		name: "ask_agent",
		label: "Ask Agent",
		description:
			"Ask an existing team member a question and wait for its answer. The question is steered into " +
			"the target agent and the final text of its next completed run is returned. Unlike delegate_task " +
			"this blocks until the answer arrives — use it when you need the answer before continuing.",
		parameters: askAgentParams,
		execute: async (_toolCallId, params) => {
			if (!team.has(params.role)) {
				const roles = team.roles();
				throw new Error(
					`No agent for role "${params.role}". Available roles: ${roles.length > 0 ? roles.join(", ") : "(none — spawn one first)"}`,
				);
			}
			if (options.selfRole !== undefined && params.role === options.selfRole) {
				throw new Error(
					`Cannot ask your own role "${params.role}" — the answer could never arrive while this run waits for it. Answer it yourself or ask another role.`,
				);
			}
			const timeoutMs = (params.timeoutSeconds ?? options.defaultTimeoutSeconds ?? 120) * 1000;
			const answer = await askAgent(team, params.role, params.question, timeoutMs);
			return {
				content: [{ type: "text", text: answer.length > 0 ? answer : `Agent "${params.role}" finished without a text reply.` }],
				details: { role: params.role, answered: answer.length > 0 },
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
	 * Project-scoped shared memory. A live planner gets memory_read and
	 * memory_write tools backed by this store (ignored in dryRun mode, which
	 * must not leave side effects).
	 */
	memory?: TeamMemory;
	/**
	 * The team's configured roles. When provided, a roster (each role's
	 * category, model, and one-line brief) is appended to the planner prompt so
	 * it routes tasks to the right existing agent by category instead of
	 * spawning new ones blind.
	 */
	availableRoles?: RoleConfig[];
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
directory, and mcpConfigPath to add tools from an mcp.json file.
Use delegate_task to hand off work without waiting, and ask_agent when you need a team
member's answer before continuing. When memory_read/memory_write are available, check the
team's shared memory for prior-run context before planning, and record decisions worth
keeping.`;

const DRY_RUN_ADDENDUM = `

You are in planning mode: spawn_agent and delegate_task record a plan instead of starting
agents — nothing executes. Cover the whole goal. Give every agent a taskId, a concrete
task, and deps listing the task ids whose results it needs; add retries for tasks likely
to be flaky. When the plan covers the goal, summarize it briefly and stop.`;

/**
 * Render the configured team as a roster the planner can route by. Categories
 * (e.g. "plan", "deep", "quick") let it match a task to the right agent tier
 * without the user choosing one.
 */
export function formatRoster(roles: RoleConfig[]): string {
	if (roles.length === 0) return "";
	const lines = roles.map((role) => {
		const category = role.category ? ` [${role.category}]` : "";
		const model = role.model ? ` (${role.model})` : "";
		const brief = firstLine(role.systemPrompt);
		return `- ${role.role}${category}${model}${brief ? `: ${brief}` : ""}`;
	});
	return (
		"\n\nYour team already has these agents — prefer delegating to them (match the task to an agent's " +
		'category, e.g. "plan" for planning, "deep" for complex implementation, "quick" for small/cheap tasks) ' +
		`instead of spawning new ones when one fits:\n${lines.join("\n")}`
	);
}

/** First line of a system prompt, trimmed, for the roster listing. */
function firstLine(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

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
		const model = options.model ?? resolveTeamModel("anthropic", "claude-sonnet-4-5");
		if (options.dryRun) {
			this.planBuffer = { roles: [], tasks: [] };
		}
		const teamTools: AgentTool<any>[] = this.planBuffer
			? [createPlanSpawnAgentTool(this.planBuffer), createPlanDelegateTaskTool(this.planBuffer)]
			: [
					createSpawnAgentTool(options.team),
					createDelegateTaskTool(options.team),
					createAskAgentTool(options.team, { selfRole: PLANNER_ROLE }),
				];
		if (!options.dryRun && options.memory) {
			teamTools.push(createMemoryReadTool(options.memory), createMemoryWriteTool(options.memory, { role: PLANNER_ROLE }));
		}
		const roster = formatRoster(options.availableRoles ?? []);
		this.agent = new Agent({
			initialState: {
				systemPrompt:
					(options.systemPrompt ?? DEFAULT_PLANNER_PROMPT) + roster + (options.dryRun ? DRY_RUN_ADDENDUM : ""),
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
