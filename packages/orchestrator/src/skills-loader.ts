import { type ExecutionEnv, loadSkills, type Skill } from "@kolisachint/hoocode-agent-core";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The skill source directories a role searches by default, in load order:
 * the user's global skills, project-local skills under `.hoocode/skills`, and a
 * plain `skills/` directory at the project root. Mirrors where the hoocode CLI
 * looks, so skills authored for hoocode are picked up unchanged.
 */
export function defaultSkillDirs(cwd: string): string[] {
	return [join(homedir(), ".hoocode", "skills"), join(cwd, ".hoocode", "skills"), join(cwd, "skills")];
}

/**
 * Load the skills available to a role: the {@link defaultSkillDirs} for `cwd`
 * plus any `extraPaths` from the role config. Missing directories are skipped by
 * the underlying loader, and loader diagnostics are ignored here — a malformed
 * skill file should never stop a role from starting.
 */
export async function loadRoleSkills(env: ExecutionEnv, cwd: string, extraPaths: string[] = []): Promise<Skill[]> {
	const dirs = [...defaultSkillDirs(cwd), ...extraPaths];
	const { skills } = await loadSkills(env, dirs);
	return skills;
}
