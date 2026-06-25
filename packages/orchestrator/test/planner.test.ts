import { describe, expect, test } from "bun:test";
import { TeamChannel } from "../src/channel.js";
import { formatRoster, Planner } from "../src/planner.js";
import { Team } from "../src/team.js";
import type { RoleConfig } from "../src/types.js";

const roles: RoleConfig[] = [
	{ role: "builder", category: "deep", model: "claude-opus-4-8", systemPrompt: "You implement features carefully.\nMore detail here." },
	{ role: "reviewer", category: "quick", model: "claude-haiku-4-5", systemPrompt: "You review diffs." },
];

describe("formatRoster", () => {
	test("lists each role with category, model, and first-line brief", () => {
		const roster = formatRoster(roles);
		expect(roster).toContain("- builder [deep] (claude-opus-4-8): You implement features carefully.");
		expect(roster).toContain("- reviewer [quick] (claude-haiku-4-5): You review diffs.");
		// only the first line of the system prompt is used
		expect(roster).not.toContain("More detail here.");
		expect(roster).toContain("prefer delegating");
	});

	test("is empty when there are no roles", () => {
		expect(formatRoster([])).toBe("");
	});
});

describe("Planner roster", () => {
	test("appends the configured roster to the planner system prompt", () => {
		const planner = new Planner({ team: new Team(new TeamChannel()), dryRun: true, availableRoles: roles });
		const systemPrompt = planner.agent.state.systemPrompt as string;
		expect(systemPrompt).toContain("builder [deep]");
		expect(systemPrompt).toContain("reviewer [quick]");
		// the dry-run addendum still comes after the roster
		expect(systemPrompt).toContain("planning mode");
	});

	test("omits the roster section when no roles are configured", () => {
		const planner = new Planner({ team: new Team(new TeamChannel()), dryRun: true });
		expect(planner.agent.state.systemPrompt as string).not.toContain("prefer delegating");
	});
});

describe("Planner roleDefaults (R2-1)", () => {
	test("a planned role without its own provider inherits roleDefaults.provider", async () => {
		const planner = new Planner({
			team: new Team(new TeamChannel()),
			dryRun: true,
			roleDefaults: { provider: "github-copilot", model: "claude-opus-4.8" },
		});
		const spawnTool = planner.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
		// The planner LLM commonly omits provider; the worker must still inherit the team's.
		await spawnTool.execute("call-1", { role: "coder", systemPrompt: "write code", model: "claude-opus-4.8", task: "go", taskId: "t1" } as any);
		const planned = planner.planBuffer!.roles.find((role) => role.role === "coder")!;
		expect(planned.provider).toBe("github-copilot");
		expect(planned.model).toBe("claude-opus-4.8");
	});

	test("an explicit provider on a planned role wins over roleDefaults", async () => {
		const planner = new Planner({
			team: new Team(new TeamChannel()),
			dryRun: true,
			roleDefaults: { provider: "github-copilot", model: "claude-opus-4.8" },
		});
		const spawnTool = planner.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
		await spawnTool.execute("call-1", { role: "coder", systemPrompt: "write code", model: "gpt-5", provider: "openai", taskId: "t1" } as any);
		const planned = planner.planBuffer!.roles.find((role) => role.role === "coder")!;
		expect(planned.provider).toBe("openai");
		expect(planned.model).toBe("gpt-5");
	});

	test("a guessed model with no provider is replaced by the default, not pinned to the inherited provider", async () => {
		const planner = new Planner({
			team: new Team(new TeamChannel()),
			dryRun: true,
			// github-copilot spells the model with a dot ("claude-sonnet-4.5").
			roleDefaults: { provider: "github-copilot", model: "claude-sonnet-4.5" },
		});
		const spawnTool = planner.agent.state.tools.find((tool) => tool.name === "spawn_agent")!;
		// The planner guesses the anthropic dash spelling and omits the provider.
		// Keeping that id against the inherited github-copilot provider would make
		// getModel() miss on dispatch, so both must come from the team default.
		const result = await spawnTool.execute("call-1", { role: "coder", systemPrompt: "write code", model: "claude-sonnet-4-5", taskId: "t1" } as any);
		const planned = planner.planBuffer!.roles.find((role) => role.role === "coder")!;
		expect(planned.provider).toBe("github-copilot");
		expect(planned.model).toBe("claude-sonnet-4.5");
		// The tool reports the resolved model, not the planner's raw guess.
		expect(result.details?.model).toBe("claude-sonnet-4.5");
	});
});
