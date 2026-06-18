import { resolve, sep } from "node:path";

/**
 * Capability ceiling for agents the planner spawns at runtime via the
 * `spawn_agent` tool. The planner is an LLM: its spawn requests are untrusted
 * input, so this policy bounds what a spawned worker may be granted regardless
 * of what the model asks for.
 *
 * It is **restrictive by default** (see {@link resolveSpawnPolicy}): MCP servers
 * are denied and a worker's `cwd` is confined to the project root unless the
 * host explicitly opens them. It governs only the dynamic, tool-driven spawn
 * path — the static roles a human declares in the team config are trusted and
 * are not run through it.
 */
export interface SpawnPolicy {
	/** May a spawned worker load MCP servers (mcpConfigPath)? Default false. */
	allowMcp?: boolean;
	/** May a spawned worker receive hoocode's built-in coding tools (defaultTools)? Default true. */
	allowDefaultTools?: boolean;
	/**
	 * Directory a worker's `cwd` must resolve within. Defaults to `process.cwd()`
	 * (the project root). Pass `null` to disable the cwd check entirely (e.g. a
	 * host that has already validated cwds itself).
	 */
	cwdRoot?: string | null;
}

/** The subset of a spawn request the policy inspects. */
export interface SpawnRequest {
	role: string;
	defaultTools?: boolean;
	mcpConfigPath?: string;
	cwd?: string;
}

interface ResolvedSpawnPolicy {
	allowMcp: boolean;
	allowDefaultTools: boolean;
	cwdRoot: string | null;
}

/** Fill a partial policy with the restrictive defaults the guard enforces. */
export function resolveSpawnPolicy(policy?: SpawnPolicy): ResolvedSpawnPolicy {
	return {
		allowMcp: policy?.allowMcp ?? false,
		allowDefaultTools: policy?.allowDefaultTools ?? true,
		// `undefined` means "not configured" → confine to the project root.
		// `null` is an explicit opt-out of the cwd check.
		cwdRoot: policy?.cwdRoot === undefined ? process.cwd() : policy.cwdRoot,
	};
}

/**
 * Reject a spawn request that exceeds the policy by throwing. The `spawn_agent`
 * tool surfaces the throw to the planner as a tool error, so the model sees why
 * the spawn was denied and can re-plan within bounds. Returns nothing when the
 * request is allowed.
 */
export function enforceSpawnPolicy(request: SpawnRequest, policy?: SpawnPolicy): void {
	const resolved = resolveSpawnPolicy(policy);
	if (request.mcpConfigPath && !resolved.allowMcp) {
		throw new Error(
			`Spawn of "${request.role}" denied by policy: MCP servers (mcpConfigPath) are not permitted. Spawn the worker without mcpConfigPath.`,
		);
	}
	if (request.defaultTools && !resolved.allowDefaultTools) {
		throw new Error(
			`Spawn of "${request.role}" denied by policy: built-in coding tools (defaultTools) are not permitted. Spawn the worker without defaultTools.`,
		);
	}
	if (resolved.cwdRoot !== null && request.cwd !== undefined) {
		const root = resolve(resolved.cwdRoot);
		const target = resolve(root, request.cwd);
		if (target !== root && !target.startsWith(root + sep)) {
			throw new Error(
				`Spawn of "${request.role}" denied by policy: cwd "${request.cwd}" resolves outside the project root "${root}".`,
			);
		}
	}
}
