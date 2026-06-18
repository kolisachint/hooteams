import {
	Agent,
	AgentHarness,
	getDefaultTools,
	JsonlSessionRepo,
	loadMcpTools,
	NodeExecutionEnv,
	type Session,
	type StreamFn,
} from "@kolisachint/hoocode-agent-core";
import { type Model } from "@kolisachint/hoocode-ai";
import { randomUUID } from "node:crypto";
import { DEFAULT_PROVIDER, resolveTeamModel } from "./auth.js";
import { createBoardTools, createMemoryReadTool, createMemoryWriteTool, type TeamMemory } from "./memory.js";
import { createAskAgentTool, createDelegateTaskTool } from "./planner.js";
import { buildRoleSystemPrompt } from "./role-prompt.js";
import type { Team } from "./team.js";
import { extractMessageText, type NodeHandle } from "./team-orchestrator.js";
import type { AgentEvent, AgentMessage, RoleConfig, TaskNode } from "./types.js";

/**
 * Appended to every node agent's system prompt so real models know how to
 * open an approval gate (see APPROVAL_MARKER in team-orchestrator.ts).
 */
export const HITL_SYSTEM_PROMPT = `When you need a human decision before you can continue, end your reply with one line in exactly this form and stop:

AWAITING_APPROVAL: <question> | <option 1>, <option 2>

The chosen option (possibly followed by extra feedback on the next lines) arrives as the next user message. Only use this for decisions you cannot make yourself.`;

/**
 * Appended to a goal validator's system prompt so it answers in the verdict
 * shape GOAL_UNMET_MARKER parses (see team-orchestrator.ts).
 */
export const VALIDATOR_PROTOCOL = `You receive the team's goal and the output of every completed task. Judge whether the goal was actually achieved — completed tasks alone do not prove it. End your reply with exactly one line:

GOAL_MET
or
GOAL_UNMET: <reason> | <id of the task to re-run>

Name the single task whose work most needs redoing. Only declare GOAL_UNMET for substantive gaps, not stylistic preferences.`;

export interface ValidatorAgentOptions {
	/** What the validator is, e.g. TeamConfig.validator. The verdict protocol is appended. */
	systemPrompt: string;
	/** Model id, resolved via getModel() unless resolveModel is given. */
	model: string;
	/** Model provider for getModel(). Defaults to DEFAULT_PROVIDER. */
	provider?: string;
	/** Resolves provider credentials per request, e.g. createHoocodeAuth(). */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Override model lookup (tests inject fakes). */
	resolveModel?: (config: RoleConfig) => Model<any>;
	/** Forwarded to the validator agent; lets tests stub the LLM. */
	streamFn?: StreamFn;
}

/**
 * Build a RunValidator.validate function: each validation pass runs a fresh
 * single-turn Agent (no tools, no shared session) and resolves with its final
 * reply text for the orchestrator to parse against GOAL_UNMET_MARKER.
 */
export function createValidatorAgent(options: ValidatorAgentOptions): (context: string) => Promise<string> {
	const config: RoleConfig = {
		role: "validator",
		systemPrompt: `${options.systemPrompt}\n\n${VALIDATOR_PROTOCOL}`,
		model: options.model,
		provider: options.provider,
	};
	return async (context: string): Promise<string> => {
		const model = options.resolveModel
			? options.resolveModel(config)
			: resolveTeamModel(config.provider ?? DEFAULT_PROVIDER, config.model);
		if (!model) {
			throw new Error(`Unknown model "${config.model}" for provider "${config.provider ?? DEFAULT_PROVIDER}"`);
		}
		const agent = new Agent({
			initialState: { systemPrompt: config.systemPrompt, model, thinkingLevel: "off", tools: [] },
			streamFn: options.streamFn,
			getApiKey: options.getApiKey,
		});
		await agent.prompt(context);
		const messages = agent.state.messages as AgentMessage[];
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]!.role === "assistant") return extractMessageText(messages[i]!);
		}
		return "";
	};
}

export interface NodeHarnessFactoryOptions {
	/** Role configs the dag's nodes are matched against by node.role. */
	roles: RoleConfig[];
	/** Namespaces node sessions so reruns of a task id don't collide across runs. */
	runId: string;
	/** Root directory for the JsonlSessionRepo holding node conversations. */
	sessionsRoot: string;
	/** Resolves provider credentials, e.g. createHoocodeAuth(). */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Override model lookup (tests inject fakes). Defaults to getModel(provider, model). */
	resolveModel?: (config: RoleConfig) => Model<any>;
	/** Forwarded to every node agent; lets tests stub the LLM. */
	streamFn?: StreamFn;
	/** Team instance for inter-agent messaging. When provided, agents get the delegate_task and ask_agent tools. */
	team?: Team;
	/** Project-scoped shared memory. When provided, agents get the memory_read and memory_write tools. */
	memory?: TeamMemory;
	/**
	 * Project rules (e.g. `.hooteams/rules/**`) injected into every role's system
	 * prompt as extra context files, after hoocode's discovered project context.
	 */
	rules?: Array<{ path: string; content: string }>;
}

/** Deterministic node session id, so resuming a restored node reopens its conversation. */
function nodeSessionId(runId: string, taskId: string): string {
	return `${runId}-${taskId}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

async function openOrCreateSession(repo: JsonlSessionRepo, id: string, cwd: string): Promise<Session> {
	const existing = (await repo.list({ cwd })).find((metadata) => metadata.id === id);
	return existing ? repo.open(existing) : repo.create({ cwd, id });
}

/**
 * Build a TeamOrchestratorOptions.createHarness backed by real hoocode
 * AgentHarness instances: one per dag node, each with its own persisted
 * session (named after runId + task id, so a restored run's resume reopens
 * the node's conversation), the role's tools, and the HITL marker protocol
 * appended to its system prompt.
 */
export function createNodeHarnessFactory(options: NodeHarnessFactoryOptions): (node: TaskNode) => Promise<NodeHandle> {
	const repo = new JsonlSessionRepo({ sessionsRoot: options.sessionsRoot });
	const byRole = new Map(options.roles.map((config) => [config.role, config]));
	const getApiKeyAndHeaders = options.getApiKey
		? async (model: Model<any>): Promise<{ apiKey: string } | undefined> => {
				const apiKey = await options.getApiKey?.(model.provider);
				return apiKey ? { apiKey } : undefined;
			}
		: undefined;

	return async (node: TaskNode): Promise<NodeHandle> => {
		const config = byRole.get(node.role);
		if (!config) {
			const roles = [...byRole.keys()];
			throw new Error(
				`No role config for "${node.role}". Configured roles: ${roles.length > 0 ? roles.join(", ") : "(none)"}`,
			);
		}
		const model = options.resolveModel
			? options.resolveModel(config)
			: resolveTeamModel(config.provider ?? DEFAULT_PROVIDER, config.model);
		if (!model) {
			throw new Error(`Unknown model "${config.model}" for provider "${config.provider ?? DEFAULT_PROVIDER}"`);
		}
		const cwd = config.cwd ?? process.cwd();
		const env = new NodeExecutionEnv({ cwd });
		const session = await openOrCreateSession(repo, nodeSessionId(options.runId, node.id), cwd);
		const tools = [...(config.defaultTools ? getDefaultTools({ cwd: config.cwd }) : []), ...(config.tools ?? [])];
		if (config.mcpConfigPath) {
			tools.push(...(await loadMcpTools(config.mcpConfigPath)));
		}
		// Inter-agent messaging: fire-and-forget delegation plus blocking
		// request-response (ask_agent waits for the target's next agent_end).
		if (options.team) {
			tools.push(createDelegateTaskTool(options.team));
			tools.push(createAskAgentTool(options.team, { selfRole: node.role }));
		}
		// Shared cross-run memory, stamped with this node's run/role provenance,
		// plus a run-scoped coordination board (task list + conflict list).
		if (options.memory) {
			tools.push(createMemoryReadTool(options.memory));
			tools.push(createMemoryWriteTool(options.memory, { runId: options.runId, role: node.role }));
			tools.push(...createBoardTools(options.memory, { runId: options.runId, role: node.role }));
		}
		// Enrich the role's prompt with hoocode's own machinery: ride the role
		// identity on hoocode's coding base (so it gets the tools list + guidelines)
		// and fold in project context + skills loaded from its cwd, then append
		// hooteams' HITL protocol marker.
		const systemPrompt = `${buildRoleSystemPrompt({
			basePrompt: config.systemPrompt,
			appendSystemPrompt: config.appendSystemPrompt,
			promptGuidelines: config.promptGuidelines,
			skillPaths: config.skillPaths,
			extraContextFiles: options.rules,
			tools,
			cwd,
		})}\n\n${HITL_SYSTEM_PROMPT}`;
		const harness = new AgentHarness({
			env,
			session,
			model,
			thinkingLevel: config.thinkingLevel,
			tools,
			systemPrompt,
			getApiKeyAndHeaders,
		});
		if (options.streamFn) {
			harness.agent.streamFn = options.streamFn;
		}
		const agentId = randomUUID();
		// Register the node as a messaging target so a concurrently-running peer's
		// delegate_task/ask_agent can reach it. dispose() releases it when the node
		// settles, so a finished node stops being addressable (peer messaging is for
		// live nodes; cross-phase coordination goes through shared memory instead).
		if (options.team) {
			options.team.adopt(node.role, agentId, harness.agent);
		}
		return {
			// AgentHarness also emits harness-own events (save_point, queue_update,
			// …) its subscribe type reflects; the orchestrator filters by event
			// type, so narrow the surface to NodeHarness here instead of casting.
			harness: {
				prompt: (text) => harness.prompt(text),
				steer: (text) => harness.steer(text),
				subscribe: (listener) => harness.subscribe((event) => listener(event as AgentEvent)),
				// Lets the orchestrator's per-node timeout actually halt the model run
				// (same abort Team.kill uses), not just free the node's slot.
				abort: () => harness.agent.abort(),
			},
			agentId,
			sessionId: (await session.getMetadata()).id,
			dispose: options.team ? () => options.team!.release(node.role, agentId) : undefined,
		};
	};
}
