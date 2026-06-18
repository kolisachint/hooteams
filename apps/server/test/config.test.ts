import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATHS, loadConfig } from "../src/config.js";

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

function tempProject(): string {
	return mkdtempSync(join(tmpdir(), "hooteams-config-"));
}

describe("loadConfig discovery", () => {
	test("prefers .agents/teams/team.json over hooteams.config.json", async () => {
		const dir = tempProject();
		try {
			mkdirSync(join(dir, ".agents", "teams"), { recursive: true });
			writeFileSync(
				join(dir, ".agents", "teams", "team.json"),
				JSON.stringify({ team: [{ role: "fromTeamJson", model: "m", systemPrompt: "s" }] }),
			);
			writeFileSync(
				join(dir, "hooteams.config.json"),
				JSON.stringify({ team: [{ role: "fromLegacy", model: "m", systemPrompt: "s" }] }),
			);
			process.chdir(dir);
			expect(DEFAULT_CONFIG_PATHS[0]).toBe(join(".agents", "teams", "team.json"));
			const config = await loadConfig();
			expect(config.team.map((r) => r.role)).toEqual(["fromTeamJson"]);
		} finally {
			process.chdir(originalCwd); // leave the dir before removing it (Windows EBUSY)
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to hooteams.config.json when no .agents/teams/team.json exists", async () => {
		const dir = tempProject();
		try {
			writeFileSync(
				join(dir, "hooteams.config.json"),
				JSON.stringify({ team: [{ role: "legacy", model: "m", systemPrompt: "s" }] }),
			);
			process.chdir(dir);
			const config = await loadConfig();
			expect(config.team.map((r) => r.role)).toEqual(["legacy"]);
		} finally {
			process.chdir(originalCwd); // leave the dir before removing it (Windows EBUSY)
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns an empty team when nothing is found", async () => {
		const dir = tempProject();
		try {
			process.chdir(dir);
			expect((await loadConfig()).team).toEqual([]);
		} finally {
			process.chdir(originalCwd); // leave the dir before removing it (Windows EBUSY)
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an explicit path still wins and must exist", async () => {
		const dir = tempProject();
		try {
			const explicit = join(dir, "custom.json");
			writeFileSync(explicit, JSON.stringify({ team: [{ role: "custom", model: "m", systemPrompt: "s" }] }));
			expect((await loadConfig(explicit)).team.map((r) => r.role)).toEqual(["custom"]);
			await expect(loadConfig(join(dir, "missing.json"))).rejects.toThrow("Config file not found");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
