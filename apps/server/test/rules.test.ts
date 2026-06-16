import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "../src/rules.js";

const cwd = mkdtempSync(join(tmpdir(), "hooteams-rules-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe("loadRules", () => {
	test("returns nothing when the rules directory is absent", () => {
		expect(loadRules(cwd, ".hooteams/rules")).toEqual([]);
	});

	test("loads *.md recursively, sorted by path, skipping empty and non-md files", () => {
		const dir = join(cwd, ".hooteams", "rules");
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "style.md"), "use tabs");
		writeFileSync(join(dir, "nested", "security.md"), "no secrets in code");
		writeFileSync(join(dir, "empty.md"), "   ");
		writeFileSync(join(dir, "notes.txt"), "ignored");

		const rules = loadRules(cwd, ".hooteams/rules");
		expect(rules).toEqual([
			{ path: join(".hooteams", "rules", "nested", "security.md"), content: "no secrets in code" },
			{ path: join(".hooteams", "rules", "style.md"), content: "use tabs" },
		]);
	});

	test("ignores a rulesDir that points at a file", () => {
		writeFileSync(join(cwd, "afile.md"), "hi");
		expect(loadRules(cwd, "afile.md")).toEqual([]);
	});
});
