import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@kolisachint/hoocode-agent-core";
import { buildRoleSystemPrompt, buildSystemPromptAvailable, type HoocodePromptApi } from "../src/role-prompt.js";

const tool = (name: string, description: string): AgentTool<any> =>
	({ name, label: name, description, parameters: {}, execute: async () => ({ content: [], details: {} }) }) as any;

/** Records the BuildSystemPromptOptions it was called with and echoes a marker prompt. */
function fakeApi(): { api: HoocodePromptApi; calls: any[] } {
	const calls: any[] = [];
	const api: HoocodePromptApi = {
		getAgentDir: () => "/home/u/.hoocode",
		loadProjectContextFiles: ({ cwd }) => ({ agentsFiles: [{ path: "AGENTS.md", content: `rules for ${cwd}` }], warnings: [] }),
		loadSkills: () => ({ skills: [{ name: "deploy" } as any] }),
		buildSystemPrompt: (options) => {
			calls.push(options);
			return "HOOCODE_BASE\n" + (options.appendSystemPrompt ?? "");
		},
	};
	return { api, calls };
}

describe("buildRoleSystemPrompt", () => {
	test("falls back to the role prompt verbatim when buildSystemPrompt is unpublished", () => {
		const api: HoocodePromptApi = {
			getAgentDir: () => "/x",
			loadProjectContextFiles: () => ({ agentsFiles: [], warnings: [] }),
			loadSkills: () => ({ skills: [] }),
			// buildSystemPrompt intentionally absent
		};
		expect(buildSystemPromptAvailable(api)).toBe(false);
		const prompt = buildRoleSystemPrompt(
			{ basePrompt: "You run ops.", appendSystemPrompt: "Be careful.", tools: [], cwd: "/srv" },
			api,
		);
		expect(prompt).toBe("You run ops.\n\nBe careful.");
	});

	test("rides the role prompt on hoocode's base via appendSystemPrompt and feeds loaders", () => {
		const { api, calls } = fakeApi();
		expect(buildSystemPromptAvailable(api)).toBe(true);
		const prompt = buildRoleSystemPrompt(
			{
				basePrompt: "You are the coder.",
				appendSystemPrompt: "Ship tests.",
				promptGuidelines: ["Prefer small PRs"],
				skillPaths: ["/extra/skills"],
				tools: [tool("bash", "Execute a bash command. Returns stdout."), tool("read", "Read a file")],
				cwd: "/srv/app",
			},
			api,
		);
		expect(prompt.startsWith("HOOCODE_BASE")).toBe(true);

		const opts = calls[0];
		// role identity + appendix ride on appendSystemPrompt, not customPrompt
		expect(opts.customPrompt).toBeUndefined();
		expect(opts.appendSystemPrompt).toBe("You are the coder.\n\nShip tests.");
		// tools become selectedTools + first-sentence snippets
		expect(opts.selectedTools).toEqual(["bash", "read"]);
		expect(opts.toolSnippets).toEqual({ bash: "Execute a bash command", read: "Read a file" });
		expect(opts.promptGuidelines).toEqual(["Prefer small PRs"]);
		expect(opts.cwd).toBe("/srv/app");
		// context + skills come from hoocode's published loaders
		expect(opts.contextFiles).toEqual([{ path: "AGENTS.md", content: "rules for /srv/app" }]);
		expect(opts.skills).toEqual([{ name: "deploy" }]);
	});
});
