import { existsSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when this module is running inside a Bun single-file executable
 * (`bun build --compile`). The module URL then lives in Bun's virtual
 * filesystem (`$bunfs` / `~BUN`) rather than on disk, so `./dist` cannot be
 * resolved relative to it — the built web UI ships next to the executable.
 */
const isBunBinary =
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");

/**
 * Absolute path to the built web UI (produced by `vite build`).
 *
 * - From source / a normal install: `./dist` next to this module.
 * - From a compiled binary: `webui/dist` next to the executable (the packaged
 *   zip places it there), since the module path is virtual.
 */
export const webuiDist: string = isBunBinary
	? join(dirname(process.execPath), "webui", "dist")
	: fileURLToPath(new URL("./dist", import.meta.url));

/** True when the web UI has been built and can be served. */
export function webuiBuilt(root: string = webuiDist): boolean {
	return existsSync(join(root, "index.html"));
}

/**
 * Resolve a request path to a built web UI asset, with SPA fallback to
 * index.html. Returns null when the UI isn't built or the path escapes the
 * dist root. Hosts use this as a GET fallback after their API router 404s, so
 * `hooteams start` can serve live mission control from the same port as the
 * SSE bridge (same origin → no CORS, no host config).
 */
export async function serveWebuiAsset(pathname: string, root: string = webuiDist): Promise<Response | null> {
	if (!webuiBuilt(root)) return null;
	const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
	const target = normalize(join(root, relative === "" ? "index.html" : relative));
	// Path-traversal guard: the resolved file must stay inside dist.
	if (target !== root && !target.startsWith(root + sep)) return null;

	const asset = Bun.file(target);
	if (await asset.exists()) return new Response(asset);

	// Unknown path with no file extension → SPA route, serve the shell.
	const index = Bun.file(join(root, "index.html"));
	if (await index.exists()) return new Response(index);
	return null;
}
