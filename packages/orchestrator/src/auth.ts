import { findEnvKeys, getEnvApiKey, getModel, type Model } from "@kolisachint/hoocode-ai";
import { getOAuthApiKey, getOAuthProvider, type OAuthCredentials } from "@kolisachint/hoocode-ai/oauth";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

/** Mirrors the entry shapes hoocode writes to ~/.hoocode/auth.json. */
export type AuthCredential = { type: "api_key"; key: string } | ({ type: "oauth" } & OAuthCredentials);

export type AuthFileData = Record<string, AuthCredential>;

export type GetApiKey = (provider: string) => Promise<string | undefined>;

export interface HoocodeAuthOptions {
	/** Path to an auth.json. Defaults to $HOOCODE_CODING_AGENT_DIR/auth.json, then ~/.hoocode/auth.json. */
	authPath?: string;
}

function expandTilde(path: string): string {
	return path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path;
}

/** The auth.json hoocode maintains; hooteams reads it instead of running its own login flow. */
export function defaultAuthPath(): string {
	const envDir = process.env.HOOCODE_CODING_AGENT_DIR;
	const dir = envDir ? expandTilde(envDir) : join(homedir(), ".hoocode");
	return join(dir, "auth.json");
}

function readAuthFile(authPath: string): AuthFileData {
	if (!existsSync(authPath)) {
		return {};
	}
	return JSON.parse(readFileSync(authPath, "utf-8")) as AuthFileData;
}

/**
 * Refresh an expired OAuth token and persist the new credentials, holding the
 * same proper-lockfile lock hoocode takes on auth.json so concurrent hoocode
 * sessions and hooteams agents never race each other's refresh.
 */
async function refreshOAuthWithLock(authPath: string, provider: string): Promise<string | undefined> {
	const release = await lockfile.lock(authPath, {
		retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
		stale: 30000,
	});
	try {
		// Another process may have refreshed while we waited for the lock.
		const data = readAuthFile(authPath);
		const cred = data[provider];
		if (cred?.type !== "oauth") {
			return undefined;
		}
		if (Date.now() < cred.expires) {
			return getOAuthProvider(provider)?.getApiKey(cred) ?? cred.access;
		}

		const oauthCreds: Record<string, OAuthCredentials> = {};
		for (const [id, value] of Object.entries(data)) {
			if (value.type === "oauth") {
				oauthCreds[id] = value;
			}
		}
		const refreshed = await getOAuthApiKey(provider, oauthCreds);
		if (!refreshed) {
			return undefined;
		}
		const merged: AuthFileData = { ...data, [provider]: { type: "oauth", ...refreshed.newCredentials } };
		writeFileSync(authPath, JSON.stringify(merged, null, 2), "utf-8");
		chmodSync(authPath, 0o600);
		return refreshed.apiKey;
	} finally {
		await release();
	}
}

/**
 * Resolve a model the way the base hoocode agent does, not via the raw static
 * table. `getModel(provider, modelId)` returns hardcoded baseUrls (e.g.
 * github-copilot's `https://api.individual.githubcopilot.com`), which 403s for
 * business/enterprise accounts behind a corporate proxy. When the provider has
 * an oauth entry in auth.json, its OAuth provider's `modifyModels()` rewrites
 * the baseUrl from the token's `proxy-ep` (proxy.business.githubcopilot.com ->
 * api.business.githubcopilot.com), matching what hoocode applies internally.
 */
export function resolveTeamModel(provider: string, modelId: string, authPath?: string): Model<any> {
	const model: Model<any> | undefined = getModel(provider as any, modelId as any);
	if (!model) {
		return model as unknown as Model<any>;
	}
	const cred = readAuthFile(authPath ?? defaultAuthPath())[provider];
	if (cred?.type === "oauth") {
		const modified = getOAuthProvider(provider)?.modifyModels?.([model], cred);
		if (modified?.[0]) {
			return modified[0];
		}
	}
	return model;
}

/**
 * Build a getApiKey function (for TeamOptions / PlannerOptions) backed by
 * hoocode's credential store. Resolution order matches hoocode:
 *
 *   1. auth.json api_key entry
 *   2. auth.json oauth entry (auto-refreshed and written back under lock)
 *   3. provider env var (e.g. ANTHROPIC_API_KEY)
 *
 * Providers with no credentials anywhere resolve to undefined except when an
 * oauth entry exists but cannot be refreshed — that state is actionable, so
 * it throws with instructions instead of failing later with a bare 401.
 */
export function createHoocodeAuth(options: HoocodeAuthOptions = {}): GetApiKey {
	const authPath = options.authPath ?? defaultAuthPath();

	return async (provider: string): Promise<string | undefined> => {
		const cred = readAuthFile(authPath)[provider];

		if (cred?.type === "api_key") {
			return cred.key;
		}

		if (cred?.type === "oauth") {
			if (Date.now() < cred.expires) {
				return getOAuthProvider(provider)?.getApiKey(cred) ?? cred.access;
			}
			let refreshError: unknown;
			try {
				const apiKey = await refreshOAuthWithLock(authPath, provider);
				if (apiKey) {
					return apiKey;
				}
			} catch (error) {
				refreshError = error;
			}
			const envKey = getEnvApiKey(provider);
			if (envKey) {
				return envKey;
			}
			const envVar = findEnvKeys(provider)?.[0] ?? "the provider's API key env var";
			throw new Error(
				`OAuth token for "${provider}" in ${authPath} is expired and could not be refreshed` +
					`${refreshError ? ` (${String(refreshError)})` : ""}. ` +
					`Run hoocode and /login again, or set ${envVar}.`,
			);
		}

		return getEnvApiKey(provider);
	};
}
