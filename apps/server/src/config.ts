import type { RoleConfig } from "@kolisachint/hooteams-orchestrator";

export interface ServerConfig {
	team: RoleConfig[];
	maxConcurrent?: number;
	port?: number;
}

export const DEFAULT_PORT = 4242;

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
	const raw = (await file.json()) as Partial<ServerConfig>;
	return validateConfig(raw, configPath);
}

export function validateConfig(raw: Partial<ServerConfig>, source: string): ServerConfig {
	if (!Array.isArray(raw.team)) {
		throw new Error(`${source}: "team" must be an array of role configs`);
	}
	const seen = new Set<string>();
	for (const role of raw.team) {
		if (typeof role.role !== "string" || typeof role.model !== "string" || typeof role.systemPrompt !== "string") {
			throw new Error(`${source}: each team entry needs string fields "role", "model", and "systemPrompt"`);
		}
		if (seen.has(role.role)) {
			throw new Error(`${source}: duplicate role "${role.role}"`);
		}
		seen.add(role.role);
	}
	return {
		team: raw.team,
		maxConcurrent: raw.maxConcurrent,
		port: raw.port,
	};
}
