import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig, resolveRolePrompt } from "@kolisachint/hooteams-server";
import { init, scanHoocodeAgents } from "../src/commands.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;
let savedCwd: string;

beforeEach(() => {
	// Pin model discovery to an empty agent dir so init falls back to the
	// documented anthropic defaults regardless of the host's ~/.hoocode.
	savedAgentDir = process.env.HOOCODE_CODING_AGENT_DIR;
	process.env.HOOCODE_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hooteams-agentdir-"));
	dirs.push(process.env.HOOCODE_CODING_AGENT_DIR);
	savedCwd = process.cwd();
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.HOOCODE_CODING_AGENT_DIR;
	else process.env.HOOCODE_CODING_AGENT_DIR = savedAgentDir;
	process.chdir(savedCwd);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "hooteams-init-aware-"));
	dirs.push(dir);
	return dir;
}

/** Write a markdown file (creating parent dirs), returning its absolute path. */
function writeFile(cwd: string, rel: string, content: string): string {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
	return abs;
}

describe("init (agent-aware)", () => {
	test("references discovered agent + skill by path, no inline content", async () => {
		const cwd = project();
		writeFile(cwd, join(".agents", "agents", "planner.md"), "---\nname: planner\ncategory: plan\nskills:\n  - git\n---\nYou are the planner.");
		writeFile(cwd, join(".agents", "skills", "git.md"), "---\nname: git\n---\nUse conventional commits.");
		await init({ cwd });

		const teamJson = await Bun.file(join(cwd, ".agents", "teams", "team.json")).json();
		expect(teamJson.team).toHaveLength(1);
		const role = teamJson.team[0];
		expect(role.role).toBe("planner");
		expect(role.category).toBe("plan");
		// path reference, not inline content
		expect(role.systemPrompt).toBeUndefined();
		expect(role.systemPromptFile).toBe("../agents/planner.md");
		expect(role.skillFiles).toEqual(["../skills/git.md"]);
	});

	test("relative paths in team.json resolve back to the source files", async () => {
		const cwd = project();
		const agentAbs = writeFile(cwd, join(".agents", "agents", "coder.md"), "---\nname: coder\n---\nWrite code.");
		const skillAbs = writeFile(cwd, join(".agents", "skills", "ts.md"), "---\nname: ts\n---\nUse strict mode.");
		// teach the agent to reference the skill
		writeFile(cwd, join(".agents", "agents", "coder.md"), "---\nname: coder\nskills: [ts]\n---\nWrite code.");
		await init({ cwd });

		const teamDir = join(cwd, ".agents", "teams");
		const teamJson = await Bun.file(join(teamDir, "team.json")).json();
		const role = teamJson.team[0];
		expect(isAbsolute(role.systemPromptFile)).toBe(false);
		expect(resolve(teamDir, role.systemPromptFile)).toBe(agentAbs);
		expect(resolve(teamDir, role.skillFiles[0])).toBe(skillAbs);
	});

	test("loadConfig resolves systemPromptFile + skillFiles into the prompt", async () => {
		const cwd = project();
		writeFile(cwd, join(".agents", "agents", "planner.md"), "---\nname: planner\nskills: [git]\n---\nYou are the planner.");
		writeFile(cwd, join(".agents", "skills", "git.md"), "---\nname: git\n---\nUse conventional commits.");
		await init({ cwd });

		const config = await loadConfig(join(cwd, ".agents", "teams", "team.json"));
		const prompt = config.team[0]?.systemPrompt ?? "";
		expect(prompt).toContain("You are the planner.");
		expect(prompt).toContain("## Skill: git");
		expect(prompt).toContain("Use conventional commits.");
		// the raw reference fields never leak through
		expect((config.team[0] as unknown as Record<string, unknown>).systemPromptFile).toBeUndefined();
		expect((config.team[0] as unknown as Record<string, unknown>).skillFiles).toBeUndefined();
	});

	test("loadConfig throws a descriptive error for a missing systemPromptFile", async () => {
		const cwd = project();
		const teamPath = join(cwd, ".agents", "teams", "team.json");
		writeFile(
			cwd,
			join(".agents", "teams", "team.json"),
			JSON.stringify({
				defaults: { provider: "anthropic", model: "claude-sonnet-4-5" },
				team: [{ role: "ghost", defaultTools: true, systemPromptFile: "../../.agents/agents/missing.md" }],
			}),
		);
		expect(loadConfig(teamPath)).rejects.toThrow(/ghost/);
		expect(loadConfig(teamPath)).rejects.toThrow(/missing\.md/);
	});

	test("inline systemPrompt still works unchanged (backward compat)", async () => {
		const cwd = project();
		const teamPath = join(cwd, ".agents", "teams", "team.json");
		writeFile(
			cwd,
			join(".agents", "teams", "team.json"),
			JSON.stringify({
				defaults: { provider: "anthropic", model: "claude-sonnet-4-5" },
				team: [{ role: "solo", defaultTools: true, systemPrompt: "Inline prompt body." }],
			}),
		);
		const config = await loadConfig(teamPath);
		expect(config.team[0]?.systemPrompt).toBe("Inline prompt body.");
	});

	test("skill frontmatter is stripped before appending", async () => {
		const cwd = project();
		const configDir = join(cwd, ".agents", "teams");
		writeFile(cwd, join(".agents", "skills", "fm.md"), "---\nname: fm\ndescription: secret\n---\nVisible body only.");
		const resolved = await resolveRolePrompt(
			{ role: "r", systemPrompt: "Base.", model: "m", skillFiles: ["../skills/fm.md"] },
			configDir,
		);
		expect(resolved.systemPrompt).toContain("Visible body only.");
		expect(resolved.systemPrompt).not.toContain("secret");
		expect(resolved.systemPrompt).not.toContain("---");
	});

	test("no agents on disk → generic inline scaffold (unchanged)", async () => {
		const cwd = project();
		await init({ cwd });
		const teamJson = await Bun.file(join(cwd, ".agents", "teams", "team.json")).json();
		expect(teamJson.team.map((r: { role: string }) => r.role)).toEqual(["planner", "coder", "reviewer"]);
		expect(teamJson.team[0].systemPrompt).toContain("You are the planner");
		expect(teamJson.team[0].systemPromptFile).toBeUndefined();
	});

	test("scanHoocodeAgents discovers the Claude layout too", () => {
		const cwd = project();
		writeFile(cwd, join(".claude", "agents", "guard.md"), "---\nname: guard\n---\nGuard the gates.");
		writeFile(cwd, join(".claude", "skills", "audit.md"), "---\nname: audit\n---\nAudit everything.");
		const { agents, skills } = scanHoocodeAgents(cwd);
		expect(agents.map((a) => a.name)).toContain("guard");
		expect(skills.map((s) => s.name)).toContain("audit");
	});

	test("scanHoocodeAgents dedupes by name, .agents wins over .claude", () => {
		const cwd = project();
		writeFile(cwd, join(".agents", "agents", "dup.md"), "---\nname: dup\ncategory: deep\n---\nFrom .agents.");
		writeFile(cwd, join(".claude", "agents", "dup.md"), "---\nname: dup\ncategory: quick\n---\nFrom .claude.");
		const { agents } = scanHoocodeAgents(cwd);
		const dup = agents.filter((a) => a.name === "dup");
		expect(dup).toHaveLength(1);
		expect(dup[0]?.category).toBe("deep");
	});
});
