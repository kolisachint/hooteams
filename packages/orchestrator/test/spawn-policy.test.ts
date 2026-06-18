import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { enforceSpawnPolicy, resolveSpawnPolicy } from "../src/spawn-policy.js";

describe("spawn policy", () => {
	test("restrictive defaults: deny MCP, allow defaultTools, confine cwd to the project root", () => {
		const resolved = resolveSpawnPolicy();
		expect(resolved.allowMcp).toBe(false);
		expect(resolved.allowDefaultTools).toBe(true);
		expect(resolved.cwdRoot).toBe(process.cwd());
	});

	test("denies mcpConfigPath by default and names the role in the error", () => {
		expect(() => enforceSpawnPolicy({ role: "builder", mcpConfigPath: "./mcp.json" })).toThrow(/"builder".*MCP/);
	});

	test("allows MCP when the policy opts in", () => {
		expect(() => enforceSpawnPolicy({ role: "builder", mcpConfigPath: "./mcp.json" }, { allowMcp: true })).not.toThrow();
	});

	test("allows defaultTools by default but can be denied explicitly", () => {
		expect(() => enforceSpawnPolicy({ role: "builder", defaultTools: true })).not.toThrow();
		expect(() => enforceSpawnPolicy({ role: "builder", defaultTools: true }, { allowDefaultTools: false })).toThrow(
			/defaultTools/,
		);
	});

	test("rejects a cwd outside the root and accepts the root and its subdirectories", () => {
		const root = resolve(process.cwd(), "fixtures");
		expect(() => enforceSpawnPolicy({ role: "builder", cwd: resolve(root, "sub/dir") }, { cwdRoot: root })).not.toThrow();
		expect(() => enforceSpawnPolicy({ role: "builder", cwd: root }, { cwdRoot: root })).not.toThrow();
		expect(() => enforceSpawnPolicy({ role: "builder", cwd: "/etc" }, { cwdRoot: root })).toThrow(/outside the project root/);
		expect(() => enforceSpawnPolicy({ role: "builder", cwd: "../escape" }, { cwdRoot: root })).toThrow(
			/outside the project root/,
		);
	});

	test("a sibling sharing a name prefix is not mistaken for being inside the root", () => {
		const root = resolve(process.cwd(), "proj");
		expect(() => enforceSpawnPolicy({ role: "builder", cwd: `${root}-evil` }, { cwdRoot: root })).toThrow(/outside/);
	});

	test("a null cwdRoot disables the cwd check entirely", () => {
		expect(() => enforceSpawnPolicy({ role: "builder", cwd: "/anywhere" }, { cwdRoot: null })).not.toThrow();
	});

	test("a request with no constrained fields always passes", () => {
		expect(() => enforceSpawnPolicy({ role: "builder" })).not.toThrow();
	});
});
