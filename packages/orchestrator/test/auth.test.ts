import {
	type OAuthCredentials,
	registerOAuthProvider,
	unregisterOAuthProvider,
} from "@kolisachint/hoocode-ai/oauth";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthFileData, createHoocodeAuth } from "../src/auth.js";

const FAKE_PROVIDER = "hooteams-test-oauth";

let dir: string;

function writeAuth(data: AuthFileData): string {
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
	return path;
}

beforeAll(() => {
	registerOAuthProvider({
		id: FAKE_PROVIDER,
		name: "Fake OAuth",
		login: () => Promise.reject(new Error("login not supported in tests")),
		refreshToken: (credentials: OAuthCredentials) => {
			if (credentials.refresh === "refresh-bad") {
				return Promise.reject(new Error("refresh rejected"));
			}
			return Promise.resolve({ refresh: "refresh-2", access: "access-2", expires: Date.now() + 60_000 });
		},
		getApiKey: (credentials: OAuthCredentials) => credentials.access,
	});
	dir = mkdtempSync(join(tmpdir(), "hooteams-auth-"));
});

afterAll(() => {
	unregisterOAuthProvider(FAKE_PROVIDER);
	rmSync(dir, { recursive: true, force: true });
});

describe("createHoocodeAuth", () => {
	test("returns api_key entries verbatim", async () => {
		const authPath = writeAuth({ myprov: { type: "api_key", key: "sk-test-123" } });
		const getApiKey = createHoocodeAuth({ authPath });
		expect(await getApiKey("myprov")).toBe("sk-test-123");
	});

	test("returns the access token for an unexpired oauth entry", async () => {
		const authPath = writeAuth({
			[FAKE_PROVIDER]: { type: "oauth", refresh: "refresh-1", access: "access-1", expires: Date.now() + 60_000 },
		});
		const getApiKey = createHoocodeAuth({ authPath });
		expect(await getApiKey(FAKE_PROVIDER)).toBe("access-1");
	});

	test("refreshes an expired oauth entry and persists the new credentials", async () => {
		const authPath = writeAuth({
			[FAKE_PROVIDER]: { type: "oauth", refresh: "refresh-1", access: "access-1", expires: Date.now() - 1000 },
		});
		const getApiKey = createHoocodeAuth({ authPath });
		expect(await getApiKey(FAKE_PROVIDER)).toBe("access-2");

		const persisted = JSON.parse(readFileSync(authPath, "utf-8")) as AuthFileData;
		const cred = persisted[FAKE_PROVIDER];
		expect(cred?.type).toBe("oauth");
		expect(cred && "access" in cred ? cred.access : undefined).toBe("access-2");
	});

	test("throws an actionable error when refresh fails and no env var covers the provider", async () => {
		const authPath = writeAuth({
			[FAKE_PROVIDER]: { type: "oauth", refresh: "refresh-bad", access: "access-1", expires: Date.now() - 1000 },
		});
		const getApiKey = createHoocodeAuth({ authPath });
		expect(getApiKey(FAKE_PROVIDER)).rejects.toThrow(/expired and could not be refreshed/);
	});

	test("resolves undefined for providers with no credentials anywhere", async () => {
		const authPath = writeAuth({});
		const getApiKey = createHoocodeAuth({ authPath });
		expect(await getApiKey("hooteams-test-nothing")).toBeUndefined();
	});

	test("resolves undefined when the auth file does not exist", async () => {
		const getApiKey = createHoocodeAuth({ authPath: join(dir, "missing", "auth.json") });
		expect(await getApiKey("hooteams-test-nothing")).toBeUndefined();
	});

	describe("env fallback", () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		const previousOauth = process.env.ANTHROPIC_OAUTH_TOKEN;

		afterEach(() => {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
			if (previousOauth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
			else process.env.ANTHROPIC_OAUTH_TOKEN = previousOauth;
		});

		test("falls back to the provider env var when auth.json has no entry", async () => {
			delete process.env.ANTHROPIC_OAUTH_TOKEN;
			process.env.ANTHROPIC_API_KEY = "sk-from-env";
			const authPath = writeAuth({});
			const getApiKey = createHoocodeAuth({ authPath });
			expect(await getApiKey("anthropic")).toBe("sk-from-env");
		});
	});
});
