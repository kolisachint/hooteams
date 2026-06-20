import type { RoleConfig, ThinkingLevel } from "@kolisachint/hooteams-orchestrator";
import { basename, dirname, extname, join, resolve } from "node:path";

/** Team-wide fallbacks applied to roles that don't set their own. */
export interface ConfigDefaults {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface ServerConfig {
	defaults?: ConfigDefaults;
	team: RoleConfig[];
	maxConcurrent?: number;
	port?: number;
	/** Root for run/node session storage. Defaults to ~/.hooteams/sessions. */
	sessionsRoot?: string;
	/** Restore and continue an interrupted run on startup. Defaults to false. */
	resumeInterrupted?: boolean;
	/**
	 * Skip the orchestrator's enforced human-in-the-loop completion gate. Defaults
	 * to false (HITL active). The CLI's --allow-autonomous overrides this. See
	 * docs/hitl-gates.md.
	 */
	allowAutonomous?: boolean;
	/** Cross-run shared team memory. Defaults to true; set false to disable. */
	memory?: boolean;
	/** Root for the per-project memory stores. Defaults to ~/.hooteams/memory. */
	memoryRoot?: string;
	/** Project the memory store is scoped to. Defaults to a key derived from the server's cwd. */
	project?: string;
	/**
	 * System prompt for a goal-completion validator. When set, every run that
	 * completes cleanly is reviewed by a validator agent (using defaults.model
	 * or the first team role's model); an unmet verdict sends the named task
	 * back for rework before the run settles.
	 */
	validator?: string;
	/**
	 * Serve the bundled web UI (live mission control) from the same port as the
	 * SSE bridge. Defaults to true when the UI has been built; set false to
	 * disable. The CLI's --no-webui overrides this.
	 */
	webui?: boolean;
	/** Override the built web UI directory. Defaults to the @kolisachint/hooteams-webui dist. */
	webuiRoot?: string;
	/**
	 * Directory of project rule files (`*.md`, searched recursively) injected into
	 * every role's system prompt as extra context. Defaults to `.agents/teams/rules`;
	 * a missing directory is simply ignored.
	 */
	rulesDir?: string;
}

export const DEFAULT_PORT = 4242;

/** A team entry as written in the config file: model may be omitted when defaults.model covers it. */
type RawRoleConfig = Omit<RoleConfig, "model" | "systemPrompt"> & { model?: string; systemPrompt?: string };

export interface RawServerConfig {
	defaults?: ConfigDefaults;
	team?: RawRoleConfig[];
	maxConcurrent?: number;
	port?: number;
	sessionsRoot?: string;
	resumeInterrupted?: boolean;
	allowAutonomous?: boolean;
	memory?: boolean;
	memoryRoot?: string;
	project?: string;
	validator?: string;
	webui?: boolean;
	webuiRoot?: string;
	rulesDir?: string;
}

/**
 * Load hooteams.config.json. Explicit path wins; otherwise looks in cwd.
 * A missing default config yields an empty team (agents get spawned by the
 * planner or via the API instead).
 */
/**
 * Default config locations, in discovery order, when no explicit path is given:
 * the conventional `.agents/teams/team.json`, then the legacy
 * `hooteams.config.json` in cwd.
 */
export const DEFAULT_CONFIG_PATHS = [join(".agents", "teams", "team.json"), "hooteams.config.json"];

/**
 * Load a team config. An explicit `path` wins (and must exist); otherwise the
 * DEFAULT_CONFIG_PATHS are tried in order. When none exist the team is empty
 * (agents get spawned by the planner or via the API instead).
 */
export async function loadConfig(path?: string): Promise<ServerConfig> {
	if (path) {
		const file = Bun.file(path);
		if (!(await file.exists())) {
			throw new Error(`Config file not found: ${path}`);
		}
		return await resolveConfigPrompts(validateConfig((await file.json()) as RawServerConfig, path), path);
	}
	for (const candidate of DEFAULT_CONFIG_PATHS) {
		const file = Bun.file(candidate);
		if (await file.exists()) {
			return await resolveConfigPrompts(validateConfig((await file.json()) as RawServerConfig, candidate), candidate);
		}
	}
	return { team: [] };
}

/**
 * Resolve every role's `systemPromptFile` / `skillFiles` references into a
 * concrete `systemPrompt`, relative to the config file's directory. The
 * resolved config is what flows through the rest of the system, so the
 * orchestrator and planner never see the raw file-reference fields.
 */
async function resolveConfigPrompts(config: ServerConfig, source: string): Promise<ServerConfig> {
	const configDir = dirname(source);
	const team = await Promise.all(config.team.map((role) => resolveRolePrompt(role, configDir)));
	return { ...config, team };
}

/**
 * Resolve a single role's prompt file references into an inline `systemPrompt`.
 * `systemPromptFile` (when set) replaces the inline prompt; each `skillFiles`
 * entry's body (frontmatter stripped) is appended under a `## Skill: <name>`
 * heading. The returned role carries a fully resolved `systemPrompt` and no
 * `systemPromptFile` / `skillFiles` fields.
 */
export async function resolveRolePrompt(role: RoleConfig, configDir: string): Promise<RoleConfig> {
	if (!role.systemPromptFile && (!role.skillFiles || role.skillFiles.length === 0)) {
		return role;
	}
	let prompt = role.systemPrompt ?? "";
	if (role.systemPromptFile) {
		const filePath = resolve(configDir, role.systemPromptFile);
		try {
			prompt = await Bun.file(filePath).text();
		} catch (err) {
			throw new Error(`[hooteams] Cannot read systemPromptFile for role "${role.role}": ${filePath}\n${err}`);
		}
	}
	if (role.skillFiles && role.skillFiles.length > 0) {
		for (const skillPath of role.skillFiles) {
			const absPath = resolve(configDir, skillPath);
			let skillBody: string;
			try {
				skillBody = await Bun.file(absPath).text();
			} catch (err) {
				throw new Error(`[hooteams] Cannot read skillFile for role "${role.role}": ${absPath}\n${err}`);
			}
			const body = stripFrontmatter(skillBody);
			const skillName = basename(absPath, extname(absPath));
			prompt += `\n\n## Skill: ${skillName}\n${body}`;
		}
	}
	// Drop the now-resolved reference fields so they never reach the orchestrator.
	const { systemPromptFile: _file, skillFiles: _skills, ...rest } = role;
	return { ...rest, systemPrompt: prompt };
}

/**
 * Strip a leading YAML frontmatter block (`---\n…\n---`) from a skill file,
 * returning the trimmed body. Files without frontmatter are returned trimmed.
 */
function stripFrontmatter(text: string): string {
	const match = text.match(/^---\n[\s\S]*?\n---\n?/);
	return (match ? text.slice(match[0].length) : text).trim();
}

export function validateConfig(raw: RawServerConfig, source: string): ServerConfig {
	if (!Array.isArray(raw.team)) {
		throw new Error(`${source}: "team" must be an array of role configs`);
	}
	const defaults = raw.defaults ?? {};
	const seen = new Set<string>();
	const team: RoleConfig[] = [];
	for (const role of raw.team) {
		if (typeof role.role !== "string") {
			throw new Error(`${source}: each team entry needs a string "role"`);
		}
		// A role's prompt may be inline (`systemPrompt`) or a file reference
		// (`systemPromptFile`, resolved later); at least one must be present.
		const hasInlinePrompt = typeof role.systemPrompt === "string";
		const hasPromptFile = typeof role.systemPromptFile === "string";
		if (!hasInlinePrompt && !hasPromptFile) {
			throw new Error(`${source}: role "${role.role}" needs a string "systemPrompt" or "systemPromptFile"`);
		}
		const model = role.model ?? defaults.model;
		if (typeof model !== "string") {
			throw new Error(`${source}: role "${role.role}" has no "model" and "defaults.model" is not set`);
		}
		if (seen.has(role.role)) {
			throw new Error(`${source}: duplicate role "${role.role}"`);
		}
		seen.add(role.role);
		team.push({
			...role,
			// A file-only role has no inline prompt yet; resolveRolePrompt fills it.
			systemPrompt: role.systemPrompt ?? "",
			model,
			provider: role.provider ?? defaults.provider,
			thinkingLevel: role.thinkingLevel ?? defaults.thinkingLevel,
		});
	}
	if (raw.sessionsRoot !== undefined && typeof raw.sessionsRoot !== "string") {
		throw new Error(`${source}: "sessionsRoot" must be a string`);
	}
	if (raw.memory !== undefined && typeof raw.memory !== "boolean") {
		throw new Error(`${source}: "memory" must be a boolean`);
	}
	if (raw.memoryRoot !== undefined && typeof raw.memoryRoot !== "string") {
		throw new Error(`${source}: "memoryRoot" must be a string`);
	}
	if (raw.project !== undefined && typeof raw.project !== "string") {
		throw new Error(`${source}: "project" must be a string`);
	}
	if (raw.validator !== undefined && typeof raw.validator !== "string") {
		throw new Error(`${source}: "validator" must be a string (the validator agent's system prompt)`);
	}
	if (raw.webui !== undefined && typeof raw.webui !== "boolean") {
		throw new Error(`${source}: "webui" must be a boolean`);
	}
	if (raw.webuiRoot !== undefined && typeof raw.webuiRoot !== "string") {
		throw new Error(`${source}: "webuiRoot" must be a string`);
	}
	if (raw.rulesDir !== undefined && typeof raw.rulesDir !== "string") {
		throw new Error(`${source}: "rulesDir" must be a string`);
	}
	return {
		defaults: raw.defaults,
		team,
		maxConcurrent: raw.maxConcurrent,
		port: raw.port,
		sessionsRoot: raw.sessionsRoot,
		resumeInterrupted: raw.resumeInterrupted === true,
		allowAutonomous: raw.allowAutonomous === true,
		memory: raw.memory,
		memoryRoot: raw.memoryRoot,
		project: raw.project,
		validator: raw.validator,
		webui: raw.webui,
		webuiRoot: raw.webuiRoot,
		rulesDir: raw.rulesDir,
	};
}
