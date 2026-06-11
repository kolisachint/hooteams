#!/usr/bin/env bun
/**
 * Bumps the `version` field in every workspace package.json
 *
 * Usage: bun scripts/bump-versions.mjs <patch|minor|major>
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const BUMP = process.argv[2];
if (!["patch", "minor", "major"].includes(BUMP)) {
	console.error("Usage: bun scripts/bump-versions.mjs <patch|minor|major>");
	process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

// Expand workspace globs (e.g. "packages/*") into concrete dirs.
const workspaceDirs = [];
for (const pattern of root.workspaces ?? []) {
	if (pattern.endsWith("/*")) {
		const parent = join(repoRoot, pattern.slice(0, -2));
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (entry.isDirectory()) workspaceDirs.push(join(parent, entry.name));
		}
	} else {
		workspaceDirs.push(join(repoRoot, pattern));
	}
}

function bump(version, kind) {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(version);
	if (!m) throw new Error(`Cannot parse version: ${version}`);
	let [major, minor, patch] = m.slice(1).map(Number);
	if (kind === "patch") patch++;
	else if (kind === "minor") {
		minor++;
		patch = 0;
	} else {
		major++;
		minor = 0;
		patch = 0;
	}
	return `${major}.${minor}.${patch}`;
}

for (const dir of workspaceDirs) {
	const pkgPath = join(dir, "package.json");
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		continue;
	}
	if (!pkg.version) continue;
	const next = bump(pkg.version, BUMP);
	console.log(`${pkg.name ?? dir}: ${pkg.version} -> ${next}`);
	pkg.version = next;
	writeFileSync(pkgPath, JSON.stringify(pkg, null, "\t") + "\n");
}
