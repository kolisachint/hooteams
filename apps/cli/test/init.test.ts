import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/commands.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
		expect(teamJson.rulesDir).toBe(".hooteams/rules");
		expect(teamJson.team[0].category).toBe("plan");

		expect(await Bun.file(join(cwd, ".hooteams", "rules", "00-style.md")).text()).toContain("Project rules");
		expect(await Bun.file(join(cwd, "AGENTS.md")).text()).toContain("AGENTS.md");
	});

	test("leaves existing files untouched without --force", async () => {
		const cwd = project();
		const agentsPath = join(cwd, "AGENTS.md");
		await Bun.write(agentsPath, "my custom agents file");
		await init({ cwd });
		expect(await Bun.file(agentsPath).text()).toBe("my custom agents file");
		// the other scaffold files were still created
		expect(await Bun.file(join(cwd, ".agents", "teams", "team.json")).exists()).toBe(true);
	});

	test("overwrites with --force", async () => {
		const cwd = project();
		const agentsPath = join(cwd, "AGENTS.md");
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
});
