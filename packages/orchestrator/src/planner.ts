import { Agent, type AgentTool, type StreamFn } from "@kolisachint/hoocode-agent-core";
import { getModel, type Model, Type } from "@kolisachint/hoocode-ai";
import { randomUUID } from "node:crypto";
import type { Team } from "./team.js";
import type { RoleConfig, ThinkingLevel } from "./types.js";

const spawnAgentParams = Type.Object({
	role: Type.String({ description: "Unique role name for the new agent, e.g. coder, tester" }),
	systemPrompt: Type.String({ description: "System prompt defining the agent's responsibilities" }),
	model: Type.String({ description: "Model id the agent should use, e.g. claude-sonnet-4-5" }),
	provider: Type.Optional(Type.String({ description: "Model provider, defaults to anthropic" })),
	task: Type.Optional(Type.String({ description: "If given, immediately prompt the new agent with this task" })),
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
 */
export function createSpawnAgentTool(team: Team): AgentTool<typeof spawnAgentParams> {
	return {
		name: "spawn_agent",
		label: "Spawn Agent",
		description:
			"Spawn a new team agent with the given role, system prompt, and model. " +
			"Set defaultTools to equip it with the built-in coding tools, mcpConfigPath to add MCP server tools, " +
			"and cwd to pick its working directory. " +
			"Optionally give it an initial task to start working on immediately.",
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
			if (params.task) {
				void agent.prompt(params.task).catch(() => {});
			}
			const toolCount = agent.state.tools.length;
			const toolNote = toolCount > 0 ? ` with ${toolCount} tools` : "";
			const note = params.task ? ` and started on its first task` : "";
			return {
				content: [{ type: "text", text: `Spawned agent "${params.role}" (${params.model})${toolNote}${note}.` }],
				details: { role: params.role, model: params.model, tools: toolCount, started: Boolean(params.task) },
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
	/** Extra tools beyond spawn_agent. */
	tools?: AgentTool<any>[];
}

const DEFAULT_PLANNER_PROMPT = `You are the planner of a team of AI agents.
Break the user's goal into tasks, spawn specialist agents with the spawn_agent tool,
and give each a focused system prompt and an initial task. Keep roles small and composable.
Workers that must touch code or run commands need tools: pass defaultTools: true for the
built-in coding tools (bash/read/edit/write/grep/find/ls), cwd to set their working
directory, and mcpConfigPath to add tools from an mcp.json file.`;

export const PLANNER_ROLE = "planner";

/**
 * The orchestrator agent. It is itself a team member (role "planner") so its
 * thinking and tool calls stream over the same channel as its workers'.
 */
export class Planner {
	readonly agent: Agent;

	constructor(options: PlannerOptions) {
		const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt ?? DEFAULT_PLANNER_PROMPT,
				model,
				thinkingLevel: options.thinkingLevel ?? "off",
				tools: [createSpawnAgentTool(options.team), ...(options.tools ?? [])],
			},
			streamFn: options.streamFn,
		});
		options.team.channel.attach(PLANNER_ROLE, randomUUID(), this.agent);
	}

	/** Run the planner against a goal. Resolves when the planning run settles. */
	async plan(goal: string): Promise<void> {
		await this.agent.prompt(goal);
	}
}
