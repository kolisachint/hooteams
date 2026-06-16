import { type AgentTool, formatSkillsForSystemPrompt, type Skill } from "@kolisachint/hoocode-agent-core";
import type { ContextFile } from "./context-loader.js";

/**
 * Inputs for {@link buildRoleSystemPrompt}. Everything is plain data the caller
 * has already gathered (tools registered for the node, files read from disk),
 * so the builder stays pure and easy to test.
 */
export interface BuildRoleSystemPromptOptions {
	/** The role's identity and responsibilities — the first thing the model reads. */
	basePrompt: string;
	/** Optional appendix injected after the guidelines (e.g. "focus on security"). */
	appendSystemPrompt?: string;
	/** Tools registered for this node; their names and descriptions form the tool list. */
	tools?: AgentTool<any>[];
	/** Extra guideline bullet points appended to the standard, tool-aware guidelines. */
	promptGuidelines?: string[];
	/** Project context files loaded from the role's cwd (AGENTS.md, etc.). */
	contextFiles?: ContextFile[];
	/** Skills available to the role, rendered as an <available_skills> block. */
	skills?: Skill[];
	/** Working directory, stamped at the end of the prompt. */
	cwd: string;
	/** Current date, stamped at the end. Defaults to now. Injectable for deterministic tests. */
	now?: Date;
}

/**
 * Assemble a role's system prompt from the same layers the hoocode CLI uses,
 * built from data hooteams gathers per role instead of importing the CLI's
 * builder (which is not part of the headless `hoocode-agent-core` package). The
 * layers, in order:
 *
 *   1. Base identity (`basePrompt`)
 *   2. Available tools — only the tools actually registered for this node
 *   3. Guidelines — tool-aware; never references a tool the node lacks
 *   4. `appendSystemPrompt` appendix
 *   5. Project context — `contextFiles` read from the role's cwd
 *   6. Skills — `<available_skills>` block, omitted when there are none
 *   7. Date + working directory — always last
 *
 * Empty layers are dropped so a minimal role still gets a clean prompt.
 */
export function buildRoleSystemPrompt(options: BuildRoleSystemPromptOptions): string {
	const tools = options.tools ?? [];
	const toolNames = new Set(tools.map((tool) => tool.name));
	const sections: string[] = [options.basePrompt.trim()];

	const toolList = formatToolList(tools);
	if (toolList) sections.push(toolList);

	sections.push(buildGuidelines(toolNames, options.promptGuidelines ?? []));

	const appendix = options.appendSystemPrompt?.trim();
	if (appendix) sections.push(appendix);

	const context = formatContextFiles(options.contextFiles ?? []);
	if (context) sections.push(context);

	const skills = formatSkillsForSystemPrompt(options.skills ?? []);
	if (skills) sections.push(skills);

	const date = (options.now ?? new Date()).toISOString().slice(0, 10);
	sections.push(`Today's date is ${date}.\nYour working directory is ${options.cwd}.`);

	return sections.join("\n\n");
}

/** One line per tool: `- name: <first sentence of its description>`. */
function formatToolList(tools: AgentTool<any>[]): string {
	if (tools.length === 0) return "";
	const lines = ["# Available tools", "You have access to the following tools:"];
	for (const tool of tools) {
		const summary = firstSentence(tool.description ?? "");
		lines.push(summary ? `- ${tool.name}: ${summary}` : `- ${tool.name}`);
	}
	return lines.join("\n");
}

/**
 * Standard guidelines, adapted to the tools the node actually has: search and
 * file-editing advice is only included when the corresponding tools exist, so
 * the prompt never advertises a capability the model can't use.
 */
function buildGuidelines(toolNames: Set<string>, extra: string[]): string {
	const lines = ["# Guidelines", "- Do what the task asks; confirm before destructive or irreversible actions."];
	if (toolNames.has("read") || toolNames.has("edit")) {
		lines.push("- Read a file before editing it, and prefer targeted edits over rewriting whole files.");
	}
	const search = ["grep", "find", "ls"].filter((name) => toolNames.has(name));
	if (search.length > 0) {
		lines.push(`- Use ${search.join("/")} to locate code instead of guessing at file paths.`);
	}
	if (toolNames.has("bash")) {
		lines.push("- Use bash for anything the other tools don't cover; keep commands non-interactive.");
	}
	lines.push("- When you finish, report what you did concisely.");
	for (const guideline of extra) {
		const trimmed = guideline.trim();
		if (trimmed) lines.push(trimmed.startsWith("-") ? trimmed : `- ${trimmed}`);
	}
	return lines.join("\n");
}

/** Render loaded context files as a single "Project context" section. */
function formatContextFiles(files: ContextFile[]): string {
	if (files.length === 0) return "";
	const lines = ["# Project context", "The following project files are authoritative. Follow them."];
	for (const file of files) {
		lines.push("", `## ${file.path}`, file.content.trim());
	}
	return lines.join("\n");
}

/** First sentence (or first line) of a tool description, trimmed for the one-line listing. */
function firstSentence(text: string): string {
	const normalized = text.trim();
	if (!normalized) return "";
	const cut = normalized.search(/[.\n]/);
	return (cut === -1 ? normalized : normalized.slice(0, cut)).trim();
}
