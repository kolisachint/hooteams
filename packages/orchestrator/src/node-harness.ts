import {
	AgentHarness,
	getDefaultTools,
	JsonlSessionRepo,
	loadMcpTools,
	NodeExecutionEnv,
	type Session,
	type StreamFn,
} from "@kolisachint/hoocode-agent-core";
import { getModel, type Model } from "@kolisachint/hoocode-ai";
import type { NodeHandle } from "./team-orchestrator.js";
import type { AgentEvent, RoleConfig, TaskNode } from "./types.js";

/**
 * Appended to every node agent's system prompt so real models know how to
 * open an approval gate (see APPROVAL_MARKER in team-orchestrator.ts).
 */
export const HITL_SYSTEM_PROMPT = `When you need a human decision before you can continue, end your reply with one line in exactly this form and stop:

AWAITING_APPROVAL: <question> | <option 1>, <option 2>

The chosen option (possibly followed by extra feedback on the next lines) arrives as the next user message. Only use this for decisions you cannot make yourself.`;

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
			: getModel((config.provider ?? "anthropic") as any, config.model as any);
		if (!model) {
			throw new Error(`Unknown model "${config.model}" for provider "${config.provider ?? "anthropic"}"`);
		}
		const cwd = config.cwd ?? process.cwd();
		const session = await openOrCreateSession(repo, nodeSessionId(options.runId, node.id), cwd);
		const tools = [...(config.defaultTools ? getDefaultTools({ cwd: config.cwd }) : []), ...(config.tools ?? [])];
		if (config.mcpConfigPath) {
			tools.push(...(await loadMcpTools(config.mcpConfigPath)));
		}
		const harness = new AgentHarness({
			env: new NodeExecutionEnv({ cwd }),
			session,
			model,
			thinkingLevel: config.thinkingLevel,
			tools,
			systemPrompt: `${config.systemPrompt}\n\n${HITL_SYSTEM_PROMPT}`,
			getApiKeyAndHeaders,
		});
		if (options.streamFn) {
			harness.agent.streamFn = options.streamFn;
		}
		return {
			// AgentHarness also emits harness-own events (save_point, queue_update,
			// …) its subscribe type reflects; the orchestrator filters by event
			// type, so narrow the surface to NodeHarness here instead of casting.
			harness: {
				prompt: (text) => harness.prompt(text),
				steer: (text) => harness.steer(text),
				subscribe: (listener) => harness.subscribe((event) => listener(event as AgentEvent)),
			},
			sessionId: (await session.getMetadata()).id,
		};
	};
}
