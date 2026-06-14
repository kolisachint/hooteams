import type { RoleConfig, ThinkingLevel } from "@kolisachint/hooteams-orchestrator";

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
}

export const DEFAULT_PORT = 4242;

/** A team entry as written in the config file: model may be omitted when defaults.model covers it. */
type RawRoleConfig = Omit<RoleConfig, "model"> & { model?: string };

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
}

/**
 * Load hooteams.config.json. Explicit path wins; otherwise looks in cwd.
 * A missing default config yields an empty team (agents get spawned by the
 * planner or via the API instead).
 */
export async function loadConfig(path?: string): Promise<ServerConfig> {
	const configPath = path ?? "hooteams.config.json";
	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		if (path) {
			throw new Error(`Config file not found: ${path}`);
		}
		return { team: [] };
	}
	const raw = (await file.json()) as RawServerConfig;
	return validateConfig(raw, configPath);
}

export function validateConfig(raw: RawServerConfig, source: string): ServerConfig {
	if (!Array.isArray(raw.team)) {
		throw new Error(`${source}: "team" must be an array of role configs`);
	}
	const defaults = raw.defaults ?? {};
	const seen = new Set<string>();
	const team: RoleConfig[] = [];
	for (const role of raw.team) {
		if (typeof role.role !== "string" || typeof role.systemPrompt !== "string") {
			throw new Error(`${source}: each team entry needs string fields "role" and "systemPrompt"`);
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
	};
}
