#!/usr/bin/env bun
/**
 * Build a standalone hooteams binary for distribution.
 *
 * Usage:
 *   bun scripts/build-binary.mjs [target]
 *
 * target (default: windows-x64):
 *   windows-x64 | linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
 *
 * Output: dist/binary/<staging dir>/ containing
 *   - hooteams[.exe]   the compiled single-file executable (`bun build --compile`)
 *   - package.json     app metadata read by the bundled hoocode-agent at startup
 *                      (it resolves its package dir next to the executable when
 *                      running as a Bun binary)
 *   - webui/dist/      the prebuilt web UI served by `hooteams start`
 *   - README.md
 *
 * CI zips the staging dir into hooteams-<target>.zip. The layout matches what
 * the runtime expects: hoocode-agent reads package.json next to the exe, and
 * packages/webui/serve.ts resolves the web UI from webui/dist next to the exe.
 */

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** target name -> { bunTarget, exe, dir } */
const TARGETS = {
	"windows-x64": { bunTarget: "bun-windows-x64", exe: "hooteams.exe" },
	"linux-x64": { bunTarget: "bun-linux-x64", exe: "hooteams" },
	"linux-arm64": { bunTarget: "bun-linux-arm64", exe: "hooteams" },
	"darwin-x64": { bunTarget: "bun-darwin-x64", exe: "hooteams" },
	"darwin-arm64": { bunTarget: "bun-darwin-arm64", exe: "hooteams" },
};

const targetName = process.argv[2] ?? "windows-x64";
const target = TARGETS[targetName];
if (!target) {
	console.error(`Unknown target "${targetName}". Options: ${Object.keys(TARGETS).join(", ")}`);
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	execSync(cmd, { encoding: "utf-8", stdio: "inherit", cwd: repoRoot, ...options });
}

const stagingName = `hooteams-${targetName}`;
const outDir = join(repoRoot, "dist", "binary", stagingName);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Build the web UI so its prebuilt dist ships next to the executable.
console.log("\n=== Building web UI ===");
run("bun run build:webui");

const webuiDist = join(repoRoot, "packages", "webui", "dist");
if (!existsSync(join(webuiDist, "index.html"))) {
	console.error("Web UI build did not produce packages/webui/dist/index.html");
	process.exit(1);
}

// 2. Compile the CLI into a single-file executable for the target platform.
console.log(`\n=== Compiling ${target.exe} for ${target.bunTarget} ===`);
const exePath = join(outDir, target.exe);
run(
	`bun build --compile --target=${target.bunTarget} ./apps/cli/src/index.ts --outfile ${JSON.stringify(exePath)}`,
);

// 3. Stage the sidecar files the runtime expects next to the executable.
console.log("\n=== Staging package contents ===");

// package.json: the bundled hoocode-agent reads name/version/hoocodeConfig from
// the file next to the executable on startup. Ship a minimal one derived from
// the CLI package (workspace-only deps are irrelevant inside the bundle).
const cliPkg = JSON.parse(readFileSync(join(repoRoot, "apps", "cli", "package.json"), "utf-8"));
const binaryPkg = {
	name: cliPkg.name,
	version: cliPkg.version,
	description: cliPkg.description,
	type: "module",
	bin: { hooteams: `./${target.exe}` },
	author: cliPkg.author,
	license: cliPkg.license,
};
writeFileSync(join(outDir, "package.json"), `${JSON.stringify(binaryPkg, null, "\t")}\n`);

// webui/dist: served by `hooteams start` (resolved next to the exe in binaries).
cpSync(webuiDist, join(outDir, "webui", "dist"), { recursive: true });

// README for context inside the zip.
const readme = join(repoRoot, "README.md");
if (existsSync(readme)) {
	cpSync(readme, join(outDir, "README.md"));
}

console.log(`\n=== Done ===\nStaged ${targetName} binary at ${outDir}`);
