import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandToWorkflow, init, listWorkflowFiles, loadWorkflow, scanCommands, workflowInit, workflowPath } from "../src/commands.js";

const dirs: string[] = [];
let savedAgentDir: string | undefined;

beforeEach(() => {
	savedAgentDir = process.env.HOOCODE_CODING_AGENT_DIR;
	process.env.HOOCODE_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "hooteams-agentdir-"));
	dirs.push(process.env.HOOCODE_CODING_AGENT_DIR);
});

afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.HOOCODE_CODING_AGENT_DIR;
	else process.env.HOOCODE_CODING_AGENT_DIR = savedAgentDir;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
	const dir = mkdtempSync(join(tmpdir(), "hooteams-workflow-"));
	dirs.push(dir);
	return dir;
}

function writeWorkflow(cwd: string, name: string, doc: unknown): void {
	const dir = join(cwd, ".agents", "workflows");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.json`), JSON.stringify(doc));
}

function writeCommand(cwd: string, rel: string, content: string): void {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
}

describe("workflow", () => {
	test("workflowPath maps a bare name to .agents/workflows/<name>.json", () => {
		const cwd = project();
		expect(workflowPath("deploy", cwd)).toBe(join(cwd, ".agents", "workflows", "deploy.json"));
	});

	test("workflowPath treats a path-like or .json arg as an explicit path", () => {
		const cwd = project();
		expect(workflowPath("custom/flow.json", cwd)).toBe(join(cwd, "custom", "flow.json"));
		expect(workflowPath("flow.json", cwd)).toBe(join(cwd, "flow.json"));
	});

	test("loadWorkflow reads a named workflow document", async () => {
		const cwd = project();
		writeWorkflow(cwd, "ship", {
			name: "ship",
			goal: "ship it",
			tasks: [{ id: "a", role: "coder" }],
		});
		const doc = await loadWorkflow("ship", cwd);
		expect(doc.name).toBe("ship");
		expect(doc.goal).toBe("ship it");
		expect(doc.tasks).toHaveLength(1);
	});

	test("loadWorkflow throws a descriptive error for a missing workflow", async () => {
		const cwd = project();
		expect(loadWorkflow("ghost", cwd)).rejects.toThrow(/workflow not found: ghost/);
	});

	test("loadWorkflow rejects a workflow with no tasks", async () => {
		const cwd = project();
		writeWorkflow(cwd, "empty", { name: "empty", tasks: [] });
		expect(loadWorkflow("empty", cwd)).rejects.toThrow(/no tasks/);
	});

	test("listWorkflowFiles digests every workflow, sorted, malformed ones survive", () => {
		const cwd = project();
		writeWorkflow(cwd, "beta", { description: "second", tasks: [{ id: "x", role: "r" }] });
		writeWorkflow(cwd, "alpha", { goal: "first", tasks: [{ id: "x", role: "r" }, { id: "y", role: "r" }] });
		// a malformed file shouldn't break the listing
		mkdirSync(join(cwd, ".agents", "workflows"), { recursive: true });
		writeFileSync(join(cwd, ".agents", "workflows", "broken.json"), "{ not json");

		const summaries = listWorkflowFiles(cwd);
		expect(summaries.map((s) => s.name)).toEqual(["alpha", "beta", "broken"]);
		expect(summaries[0]).toMatchObject({ name: "alpha", goal: "first", taskCount: 2 });
		expect(summaries[1]).toMatchObject({ name: "beta", description: "second", taskCount: 1 });
		expect(summaries[2]).toMatchObject({ name: "broken", taskCount: 0 });
	});

	test("listWorkflowFiles returns [] when there is no workflows dir", () => {
		const cwd = project();
		expect(listWorkflowFiles(cwd)).toEqual([]);
	});

	test("init scaffolds a runnable example workflow wired to the team roles", async () => {
		const cwd = project();
		await init({ cwd });
		const doc = await loadWorkflow("example", cwd);
		expect(doc.name).toBe("example");
		expect(doc.tasks.map((t) => t.id)).toEqual(["plan", "build", "review"]);
		// the example targets the generic scaffolded trio and chains its deps
		expect(doc.tasks.map((t) => t.role)).toEqual(["planner", "coder", "reviewer"]);
		expect(doc.tasks[1]?.deps).toEqual(["plan"]);
		expect(doc.tasks[2]?.deps).toEqual(["build"]);
	});

	test("scanCommands reads frontmatter (block scalar) and body, dedups .agents over .claude", () => {
		const cwd = project();
		writeCommand(
			cwd,
			join(".agents", "commands", "pr.md"),
			"---\nname: pr\ndescription: |\n  Open a release PR.\n  Usage: /pr <bump>\n---\nDo the PR steps here.",
		);
		writeCommand(cwd, join(".claude", "commands", "pr.md"), "---\nname: pr\n---\nFrom claude.");
		writeCommand(cwd, join(".claude", "commands", "deploy.md"), "---\nname: deploy\n---\nShip it.");

		const commands = scanCommands(cwd);
		const names = commands.map((c) => c.name).sort();
		expect(names).toEqual(["deploy", "pr"]);
		const pr = commands.find((c) => c.name === "pr");
		// .agents wins over .claude
		expect(pr?.body).toBe("Do the PR steps here.");
		expect(pr?.description).toContain("Open a release PR.");
		expect(pr?.description).toContain("Usage: /pr <bump>");
	});

	test("commandToWorkflow makes a single-task graph running the body on the role", () => {
		const doc = commandToWorkflow(
			{ name: "pr", description: "Open a release PR.\nUsage: /pr", body: "Step 1. Step 2.", file: "x" },
			"planner",
		);
		expect(doc.name).toBe("pr");
		expect(doc.description).toBe("Open a release PR.");
		expect(doc.goal).toBe("Open a release PR.\nUsage: /pr");
		expect(doc.tasks).toEqual([{ id: "pr", role: "planner", prompt: "Step 1. Step 2." }]);
	});

	test("commandToWorkflow falls back to a generated description when none is given", () => {
		const doc = commandToWorkflow({ name: "bare", body: "Just do it.", file: "x" }, "coder");
		expect(doc.description).toContain('"bare"');
		expect(doc.goal).toBeUndefined();
	});

	test("workflowInit generates a workflow per command, on the team's planner role", async () => {
		const cwd = project();
		await init({ cwd }); // scaffolds team.json (planner is the plan-category role)
		writeCommand(cwd, join(".agents", "commands", "pr.md"), "---\nname: pr\ndescription: Open a PR.\n---\nPR body.");
		writeCommand(cwd, join(".agents", "commands", "audit.md"), "---\nname: audit\n---\nAudit body.");

		await workflowInit({ cwd });

		const pr = await loadWorkflow("pr", cwd);
		expect(pr.tasks).toEqual([{ id: "pr", role: "planner", prompt: "PR body." }]);
		expect(pr.description).toBe("Open a PR.");
		const audit = await loadWorkflow("audit", cwd);
		expect(audit.tasks[0]?.prompt).toBe("Audit body.");
	});

	test("workflowInit skips existing workflows without --force", async () => {
		const cwd = project();
		writeCommand(cwd, join(".agents", "commands", "pr.md"), "---\nname: pr\n---\nNew body.");
		writeWorkflow(cwd, "pr", { name: "pr", tasks: [{ id: "pr", role: "planner", prompt: "Old body." }] });

		await workflowInit({ cwd });
		expect((await loadWorkflow("pr", cwd)).tasks[0]?.prompt).toBe("Old body.");

		await workflowInit({ cwd, force: true });
		expect((await loadWorkflow("pr", cwd)).tasks[0]?.prompt).toBe("New body.");
	});

	test("workflowInit scaffolds from .claude/commands too", async () => {
		const cwd = project();
		writeCommand(cwd, join(".claude", "commands", "release.md"), "---\nname: release\ndescription: Cut a release.\n---\nRelease body.");
		await workflowInit({ cwd });
		const doc = await loadWorkflow("release", cwd);
		expect(doc.tasks[0]?.prompt).toBe("Release body.");
		expect(doc.description).toBe("Cut a release.");
	});

	test("workflowInit is a no-op when there are no commands", async () => {
		const cwd = project();
		await workflowInit({ cwd });
		expect(listWorkflowFiles(cwd)).toEqual([]);
	});

	test("workflowInit defaults to planner role when no team.json exists", async () => {
		const cwd = project();
		writeCommand(cwd, join(".agents", "commands", "solo.md"), "---\nname: solo\n---\nSolo body.");
		await workflowInit({ cwd });
		expect((await loadWorkflow("solo", cwd)).tasks[0]?.role).toBe("planner");
	});
});
