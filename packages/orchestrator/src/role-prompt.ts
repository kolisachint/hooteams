import * as hoocodeAgent from "@kolisachint/hoocode-agent";
import type { BuildSystemPromptOptions } from "@kolisachint/hoocode-agent";
import type { AgentTool } from "@kolisachint/hoocode-agent-core";

/**
 * The slice of `@kolisachint/hoocode-agent` this module relies on. `buildSystemPrompt`
 * is optional: the export landed on a hoocode branch that is not yet published,
 * so until a release ships it the function is simply absent from the package
 * barrel (a namespace import yields `undefined` rather than throwing). The
 * loaders below are published and used directly — re-implementing them here
 * would drift from the CLI's behavior, which is exactly what this integration
 * avoids. Surfaced as an interface so tests can inject a fake.
 */
export interface HoocodePromptApi {
	/** Present once hoocode publishes the prompt/tools export. */
	buildSystemPrompt?: (options: BuildSystemPromptOptions) => string;
	loadProjectContextFiles: (options: { cwd: string; agentDir: string }) => {
		agentsFiles: Array<{ path: string; content: string }>;
		warnings: string[];
	};
	loadSkills: (options: {
		cwd: string;
		agentDir: string;
		skillPaths: string[];
		includeDefaults: boolean;
		includeClaude?: boolean;
	}) => { skills: BuildSystemPromptOptions["skills"] };
	getAgentDir: () => string;
}

const defaultApi = hoocodeAgent as unknown as HoocodePromptApi;

/** Whether the installed hoocode-agent exposes `buildSystemPrompt` yet. */
export function buildSystemPromptAvailable(api: HoocodePromptApi = defaultApi): boolean {
	return typeof api.buildSystemPrompt === "function";
}

/** What a role contributes to its system prompt before hoocode's machinery wraps it. */
export interface RolePromptInputs {
	/** The role's identity/responsibilities (RoleConfig.systemPrompt). */
	basePrompt: string;
	/** Extra appendix after the role prompt (RoleConfig.appendSystemPrompt). */
	appendSystemPrompt?: string;
	/** Extra guideline bullets (RoleConfig.promptGuidelines). */
	promptGuidelines?: string[];
	/** Extra skill paths beyond hoocode's defaults (RoleConfig.skillPaths). */
	skillPaths?: string[];
	/**
	 * Project rules injected as additional context files, after the files hoocode
	 * discovers in `cwd` (e.g. `.hooteams/rules/**`). Same `{ path, content }`
	 * shape buildSystemPrompt expects.
	 */
	extraContextFiles?: Array<{ path: string; content: string }>;
	/** Tools registered for this node; their names/descriptions drive the tool list. */
	tools: AgentTool<any>[];
	/** Working directory the role runs in. */
	cwd: string;
}

/**
 * Build a role's system prompt with hoocode's `buildSystemPrompt`.
 *
 * The role text rides on hoocode's default coding-assistant base via
 * `appendSystemPrompt` (the chosen mapping), so every role gets hoocode's
 * Available-tools list and guidelines. Project context and skills are loaded
 * with hoocode's own published loaders, scoped to the role's `cwd`.
 *
 * Until hoocode publishes `buildSystemPrompt`, this returns the role prompt
 * unchanged — the same text roles received before this integration — so the
 * build stays green and the rich prompt activates automatically once the
 * export ships. The caller appends hooteams' HITL protocol afterward.
 */
export function buildRoleSystemPrompt(inputs: RolePromptInputs, api: HoocodePromptApi = defaultApi): string {
	const append = [inputs.basePrompt.trim(), inputs.appendSystemPrompt?.trim()].filter(Boolean).join("\n\n");
	if (!api.buildSystemPrompt) return append;

	const agentDir = api.getAgentDir();
	const { agentsFiles } = api.loadProjectContextFiles({ cwd: inputs.cwd, agentDir });
	const contextFiles = [...agentsFiles, ...(inputs.extraContextFiles ?? [])];
	const { skills } = api.loadSkills({
		cwd: inputs.cwd,
		agentDir,
		skillPaths: inputs.skillPaths ?? [],
		includeDefaults: true,
	});
	const toolSnippets: Record<string, string> = {};
	for (const tool of inputs.tools) {
		const snippet = firstSentence(tool.description ?? "");
		if (snippet) toolSnippets[tool.name] = snippet;
	}
	return api.buildSystemPrompt({
		appendSystemPrompt: append,
		selectedTools: inputs.tools.map((tool) => tool.name),
		toolSnippets,
		promptGuidelines: inputs.promptGuidelines,
		contextFiles,
		skills,
		cwd: inputs.cwd,
	});
}

/** First sentence (or first line) of a tool description, for the one-line tool listing. */
function firstSentence(text: string): string {
	const normalized = text.trim();
	if (!normalized) return "";
	const cut = normalized.search(/[.\n]/);
	return (cut === -1 ? normalized : normalized.slice(0, cut)).trim();
}
