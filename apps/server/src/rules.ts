import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** A project rule file injected into role prompts as context. */
export interface RuleFile {
	/** Path relative to `cwd`, used as the context section heading. */
	path: string;
	/** File contents. */
	content: string;
}

/**
 * Load every `*.md` file under `rulesDir` (recursively) as a rule, resolved
 * against `cwd`. Returns them sorted by path for a stable prompt. A missing
 * directory yields no rules; unreadable files are skipped. This is hooteams'
 * own rule channel — distinct from hoocode's project-context discovery, whose
 * output it is appended after.
 */
export function loadRules(cwd: string, rulesDir: string): RuleFile[] {
	// resolve() honors an absolute rulesDir and roots a relative one at cwd.
	const root = resolve(cwd, rulesDir);
	const rules: RuleFile[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // missing or unreadable directory
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				try {
					const content = readFileSync(full, "utf-8");
					if (content.trim().length > 0) rules.push({ path: relative(cwd, full), content });
				} catch {
					// skip unreadable file
				}
			}
		}
	};
	// statSync guards the case where rulesDir points at a file, not a dir.
	try {
		if (!statSync(root).isDirectory()) return [];
	} catch {
		return [];
	}
	walk(root);
	rules.sort((a, b) => a.path.localeCompare(b.path));
	return rules;
}
