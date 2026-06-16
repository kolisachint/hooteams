import type { ExecutionEnv } from "@kolisachint/hoocode-agent-core";
import { join } from "node:path";

/**
 * Project context filenames a role looks for in its working directory, in
 * priority order. These mirror the files the hoocode CLI loads before building
 * its system prompt, so a role rooted at a repo gets the same project guidance
 * a human running hoocode there would.
 */
export const CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md", ".hoocode/context.md"] as const;

/** A project context file discovered in a role's working directory. */
export interface ContextFile {
	/** Path relative to the role's cwd, used as the section heading in the prompt. */
	path: string;
	/** File contents. */
	content: string;
}

/**
 * Load the project context files present in `cwd`, in {@link CONTEXT_FILENAMES}
 * order. Missing or empty files are skipped; read failures are swallowed so a
 * single unreadable file never blocks building a role's system prompt. Reads go
 * through the {@link ExecutionEnv} so the same loader works against a mocked
 * filesystem in tests.
 */
export async function loadContextFiles(env: ExecutionEnv, cwd: string): Promise<ContextFile[]> {
	const results: ContextFile[] = [];
	for (const filename of CONTEXT_FILENAMES) {
		try {
			const content = await env.readTextFile(join(cwd, filename));
			if (content.trim().length > 0) results.push({ path: filename, content });
		} catch {
			// Missing or unreadable — skip it.
		}
	}
	return results;
}
