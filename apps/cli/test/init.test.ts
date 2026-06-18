import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;

beforeEach(() => {
	// Pin model discovery to an empty agent dir so init falls back to the
	// documented anthropic defaults regardless of the host's ~/.hoocode.
	savedAgentDir = process.env.HOOCODE_CODING_AGENT_DIR;
	process.env.HOOCODE_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hooteams-agentdir-"));
	dirs.push(process.env.HOOCODE_CODING_AGENT_DIR);
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.HOOCODE_CODING_AGENT_DIR;
	else process.env.HOOCODE_CODING_AGENT_DIR = savedAgentDir;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write a hoocode settings.json into the pinned agent dir for discovery tests. */
function writeHoocodeSettings(settings: Record<string, unknown>): void {
	const dir = process.env.HOOCODE_CODING_AGENT_DIR as string;
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "hooteams-init-"));
	dirs.push(dir);
	return dir;
}

describe("init", () => {
	test("scaffolds team.json, a rule, and AGENTS.md", async () => {
		const cwd = project();
		await init({ cwd });

		const teamJson = await Bun.file(join(cwd, ".agents", "teams", "team.json")).json();
		expect(teamJson.team.map((r: { role: string }) => r.role)).toEqual(["planner", "coder", "reviewer"]);
		expect(teamJson.rulesDir).toBe(".agents/teams/rules");
		expect(teamJson.team[0].category).toBe("plan");

		expect(await Bun.file(join(cwd, ".agents", "teams", "rules", "00-style.md")).text()).toContain("Project rules");
		// AGENTS.md lives in the rules dir so it is injected into prompts
		expect(await Bun.file(join(cwd, ".agents", "teams", "rules", "AGENTS.md")).text()).toContain("AGENTS.md");
	});

	test("leaves existing files untouched without --force", async () => {
		const cwd = project();
		const agentsPath = join(cwd, ".agents", "teams", "rules", "AGENTS.md");
		await Bun.write(agentsPath, "my custom agents file");
		await init({ cwd });
		expect(await Bun.file(agentsPath).text()).toBe("my custom agents file");
		// the other scaffold files were still created
		expect(await Bun.file(join(cwd, ".agents", "teams", "team.json")).exists()).toBe(true);
	});

	test("overwrites with --force", async () => {
		const cwd = project();
		const agentsPath = join(cwd, ".agents", "teams", "rules", "AGENTS.md");
		await Bun.write(agentsPath, "stale");
		await init({ cwd, force: true });
		expect(await Bun.file(agentsPath).text()).toContain("Guidance for AI agents");
	});

	test("the scaffolded team.json is valid for the config loader", async () => {
		const cwd = project();
		await init({ cwd });
		const { validateConfig } = await import("@kolisachint/hooteams-server");
		const raw = await Bun.file(join(cwd, ".agents", "teams", "team.json")).json();
		const config = validateConfig(raw, "team.json");
		expect(config.team).toHaveLength(3);
		expect(config.team[1]?.model).toBe("claude-sonnet-4-5"); // from defaults
	});

	test("wires team.json defaults from hoocode's settings.json", async () => {
		writeHoocodeSettings({ defaultProvider: "openai", defaultModel: "gpt-5-codex" });
		const cwd = project();
		await init({ cwd });
		const teamJson = await Bun.file(join(cwd, ".agents", "teams", "team.json")).json();
		expect(teamJson.defaults).toEqual({ provider: "openai", model: "gpt-5-codex" });
	});

	test("falls back to anthropic defaults when hoocode has no settings", async () => {
		const cwd = project();
		await init({ cwd });
		const teamJson = await Bun.file(join(cwd, ".agents", "teams", "team.json")).json();
		expect(teamJson.defaults).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
	});
});
