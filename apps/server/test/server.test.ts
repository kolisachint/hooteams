import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.js";
import { startServer } from "../src/server.js";

const fakeModel = {
	id: "fake-model",
	name: "fake",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 4096,
} as any;

describe("validateConfig", () => {
	test("accepts a valid config", () => {
		const config = validateConfig(
			{ team: [{ role: "coder", model: "m", systemPrompt: "s" }], maxConcurrent: 2 },
			"test",
		);
		expect(config.team).toHaveLength(1);
		expect(config.maxConcurrent).toBe(2);
	});

	test("rejects missing team array and malformed entries", () => {
		expect(() => validateConfig({}, "test")).toThrow(/"team" must be an array/);
		expect(() => validateConfig({ team: [{ role: "x" } as any] }, "test")).toThrow(/needs string fields/);
		expect(() =>
			validateConfig(
				{
					team: [
						{ role: "x", model: "m", systemPrompt: "s" },
						{ role: "x", model: "m", systemPrompt: "s" },
					],
				},
				"test",
			),
		).toThrow(/duplicate role "x"/);
	});

	test("fills model, provider, and thinkingLevel from defaults", () => {
		const config = validateConfig(
			{
				defaults: { provider: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "low" },
				team: [
					{ role: "planner", systemPrompt: "plan" },
					{ role: "coder", systemPrompt: "code", model: "claude-haiku-4-5", provider: "other", thinkingLevel: "off" },
				],
			},
			"test",
		);
		expect(config.team[0]).toMatchObject({
			model: "claude-sonnet-4-5",
			provider: "anthropic",
			thinkingLevel: "low",
		});
		expect(config.team[1]).toMatchObject({ model: "claude-haiku-4-5", provider: "other", thinkingLevel: "off" });
	});

	test("rejects a role without model when defaults.model is missing", () => {
		expect(() => validateConfig({ team: [{ role: "x", systemPrompt: "s" }] }, "test")).toThrow(
			/role "x" has no "model"/,
		);
	});
});

describe("startServer", () => {
	test("spawns the configured team and serves status until /stop", async () => {
		const running = startServer(
			{ team: [{ role: "coder", model: "fake-model", systemPrompt: "code" }] },
			{ port: 0, teamOptions: { resolveModel: () => fakeModel } },
		);
		const base = `http://localhost:${running.port}`;

		expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true });
		const status = (await (await fetch(`${base}/status`)).json()) as Record<string, { status: string }>;
		expect(status.coder?.status).toBe("idle");

		const stopResponse = await fetch(`${base}/stop`, { method: "POST" });
		expect(((await stopResponse.json()) as { stopping: boolean }).stopping).toBe(true);

		// Server should refuse connections shortly after.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await expect(fetch(`${base}/health`)).rejects.toThrow();
	});
});
