import { afterAll, describe, expect, test } from "bun:test";
import { NodeExecutionEnv } from "@kolisachint/hoocode-agent-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextFiles } from "../src/context-loader.js";

const dir = mkdtempSync(join(tmpdir(), "hooteams-context-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadContextFiles", () => {
	test("returns nothing when no context files exist", async () => {
		const env = new NodeExecutionEnv({ cwd: dir });
		expect(await loadContextFiles(env, dir)).toEqual([]);
	});

	test("loads present files in priority order and skips empty ones", async () => {
		writeFileSync(join(dir, "AGENTS.md"), "agents guide");
		writeFileSync(join(dir, "CLAUDE.md"), "   "); // whitespace-only is skipped
		const env = new NodeExecutionEnv({ cwd: dir });
		const files = await loadContextFiles(env, dir);
		expect(files).toEqual([{ path: "AGENTS.md", content: "agents guide" }]);
	});
});
