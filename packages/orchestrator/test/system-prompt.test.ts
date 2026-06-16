import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@kolisachint/hoocode-agent-core";
import type { ContextFile } from "../src/context-loader.js";
import { buildRoleSystemPrompt } from "../src/system-prompt.js";

const tool = (name: string, description: string): AgentTool<any> =>
	({ name, label: name, description, parameters: {}, execute: async () => ({ content: [], details: {} }) }) as any;

const now = new Date("2026-06-16T12:00:00Z");

describe("buildRoleSystemPrompt", () => {
	test("leads with the base prompt and stamps date + cwd last", () => {
		const prompt = buildRoleSystemPrompt({ basePrompt: "You run ops.", cwd: "/srv/app", now });
		expect(prompt.startsWith("You run ops.")).toBe(true);
		expect(prompt).toContain("Today's date is 2026-06-16.");
		expect(prompt).toContain("Your working directory is /srv/app.");
		// date/cwd is the final section
		expect(prompt.trimEnd().endsWith("Your working directory is /srv/app.")).toBe(true);
	});

	test("lists registered tools with the first sentence of each description", () => {
		const prompt = buildRoleSystemPrompt({
			basePrompt: "base",
			cwd: "/x",
			now,
			tools: [tool("bash", "Execute a bash command. Returns stdout.")],
		});
		expect(prompt).toContain("# Available tools");
		expect(prompt).toContain("- bash: Execute a bash command");
		// only the first sentence is kept
		expect(prompt).not.toContain("Returns stdout");
	});

	test("guidelines only mention tools that are present", () => {
		const withSearch = buildRoleSystemPrompt({
			basePrompt: "base",
			cwd: "/x",
			now,
			tools: [tool("grep", "search"), tool("find", "find files")],
		});
		expect(withSearch).toContain("Use grep/find to locate code");

		const withoutSearch = buildRoleSystemPrompt({ basePrompt: "base", cwd: "/x", now });
		expect(withoutSearch).not.toContain("to locate code");
	});

	test("appends custom guidelines and the appendSystemPrompt appendix", () => {
		const prompt = buildRoleSystemPrompt({
			basePrompt: "base",
			cwd: "/x",
			now,
			promptGuidelines: ["Prefer small PRs", "- Write tests"],
			appendSystemPrompt: "You are the reviewer.",
		});
		expect(prompt).toContain("- Prefer small PRs");
		expect(prompt).toContain("- Write tests");
		expect(prompt).toContain("You are the reviewer.");
	});

	test("renders project context and skills, omitting empty sections", () => {
		const contextFiles: ContextFile[] = [{ path: "AGENTS.md", content: "Repo rules." }];
		const prompt = buildRoleSystemPrompt({
			basePrompt: "base",
			cwd: "/x",
			now,
			contextFiles,
			skills: [{ name: "deploy", description: "ship it", content: "...", filePath: "/skills/deploy.md" }],
		});
		expect(prompt).toContain("# Project context");
		expect(prompt).toContain("## AGENTS.md");
		expect(prompt).toContain("Repo rules.");
		expect(prompt).toContain("<available_skills>");
		expect(prompt).toContain("deploy");

		const bare = buildRoleSystemPrompt({ basePrompt: "base", cwd: "/x", now });
		expect(bare).not.toContain("# Project context");
		expect(bare).not.toContain("<available_skills>");
	});

	test("hidden skills are not listed", () => {
		const prompt = buildRoleSystemPrompt({
			basePrompt: "base",
			cwd: "/x",
			now,
			skills: [{ name: "secret", description: "x", content: "y", filePath: "/s.md", disableModelInvocation: true }],
		});
		expect(prompt).not.toContain("<available_skills>");
	});
});
