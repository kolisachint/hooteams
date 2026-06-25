/**
 * Model tiers, mirroring hoocode's `settings.json` `modelCategories`. A team
 * member's model can be named by tier instead of by a concrete, provider-specific
 * id: the planner (an LLM) reliably judges *how capable* a worker needs to be
 * ("this is small — give it something cheap") but cannot reliably recall that
 * github-copilot spells a model `claude-sonnet-4.5` while anthropic spells it
 * `claude-sonnet-4-5`. A tier is provider-agnostic, so the host resolves it to
 * whatever concrete id the user configured for their provider — the spelling is
 * never authored by the planner and so can never be wrong.
 *
 * This is the same vocabulary and resolution rule hoocode uses for its own
 * subagent dispatch (`resolveModelCategory` / the TodoWrite `complexity` field),
 * so a hooteams team and the hoocode CLI it runs on agree on what "capable" means.
 */
export const MODEL_CATEGORIES = ["fast", "standard", "capable"] as const;

export type ModelCategory = (typeof MODEL_CATEGORIES)[number];

/** Map of tier → concrete model id, as configured in hoocode's settings.json. */
export type ModelCategories = Partial<Record<ModelCategory, string>>;

/** Narrow an arbitrary model string to one of the three known tiers. */
export function isModelCategory(value: string): value is ModelCategory {
	return (MODEL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Resolve a tier to its configured concrete model id. Mirrors hoocode's
 * `resolveModelCategory`: an unconfigured tier returns `undefined` — there is no
 * built-in default, so the caller keeps its existing/default model and the tier
 * is a no-op rather than an error.
 */
export function resolveModelCategory(category: ModelCategory, categories?: ModelCategories): string | undefined {
	return categories?.[category];
}
