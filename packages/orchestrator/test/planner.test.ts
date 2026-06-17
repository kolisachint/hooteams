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
