import type { AgentTool } from "@kolisachint/hoocode-agent-core";
import { Type } from "@kolisachint/hoocode-ai";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** One remembered fact in a project's shared memory store. */
export interface MemoryEntry {
	key: string;
	value: string;
	tags: string[];
	/** Run that wrote the entry, when it came from a task output. */
	runId?: string;
	/** Role that wrote the entry, when known. */
	role?: string;
	createdAt: number;
	updatedAt: number;
}

export interface TeamMemoryOptions {
	/** Directory holding one JSON store per project. Default ~/.hooteams/memory. */
	memoryRoot?: string;
	/** Project the store is scoped to. Default: projectKeyFromCwd(process.cwd()). */
	project?: string;
	/** Entries kept per project; the least recently written are evicted first. Default 500. */
	maxEntries?: number;
}

export function defaultMemoryRoot(): string {
	return join(homedir(), ".hooteams", "memory");
}

/**
 * Stable, filename-safe project key for a working directory: the directory's
 * basename plus a short hash of the full path, so two checkouts with the same
 * name get separate stores while reruns from the same path share one.
 */
export function projectKeyFromCwd(cwd: string): string {
	const name = basename(cwd).replace(/[^a-zA-Z0-9_-]/g, "-") || "project";
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
	return `${name}-${hash}`;
}

/** A settled task as TeamOrchestrator reports it to recordTask(). */
export interface MemoryTaskRecord {
	runId: string;
	taskId: string;
	role: string;
	status: "done" | "error";
	output?: string;
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Tag stamped on run-scoped coordination-board entries (see createBoardTools).
 * bootstrapContext skips these so a run's transient task/conflict notes never
 * leak into a later run's prompts.
 */
const BOARD_TAG = "board";

/**
 * Shared knowledge store scoped to a project, not a run: one JSON file per
 * project under memoryRoot, surviving across runs and shared by every agent
 * on the team. Agents read and write it through the memory_read/memory_write
 * tools; the orchestrator auto-records task outputs at run end (recordTask)
 * and new runs bootstrap prior context from it (bootstrapContext).
 *
 * All operations are serialized on one promise chain and saves are atomic
 * (write temp file, then rename), so concurrent agents in one process never
 * interleave or torn-write the file. A missing or unreadable file yields an
 * empty store rather than an error.
 */
export class TeamMemory {
	readonly project: string;
	/** Path of the project's JSON store. */
	readonly file: string;
	private readonly maxEntries: number;
	private cache?: Map<string, MemoryEntry>;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(options: TeamMemoryOptions = {}) {
		this.project = options.project ?? projectKeyFromCwd(process.cwd());
		const root = options.memoryRoot ?? defaultMemoryRoot();
		this.file = join(root, `${this.project.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`);
		this.maxEntries = options.maxEntries ?? 500;
	}

	/** Upsert an entry. Re-writing a key refreshes its recency and keeps createdAt. */
	write(key: string, value: string, meta: { tags?: string[]; runId?: string; role?: string } = {}): Promise<MemoryEntry> {
		return this.enqueue(async () => {
			const entries = await this.load();
			const existing = entries.get(key);
			const now = Date.now();
			const entry: MemoryEntry = {
				key,
				value,
				tags: meta.tags ?? existing?.tags ?? [],
				runId: meta.runId ?? existing?.runId,
				role: meta.role ?? existing?.role,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			// Delete-then-set keeps map order = write recency, so eviction can
			// drop from the front.
			entries.delete(key);
			entries.set(key, entry);
			while (entries.size > this.maxEntries) {
				const oldest = entries.keys().next().value as string;
				entries.delete(oldest);
			}
			await this.save(entries);
			return entry;
		});
	}

	/**
	 * Atomically append a line to the list stored under `key`. The
	 * read-modify-write runs inside the same serialized chain as every other
	 * store op, so concurrent appenders never lose each other's items — unlike
	 * write(), which is a whole-value upsert and would clobber a racing append.
	 * Creates the key on first append; refreshes recency and keeps createdAt.
	 */
	append(key: string, item: string, meta: { tags?: string[]; runId?: string; role?: string } = {}): Promise<MemoryEntry> {
		return this.enqueue(async () => {
			const entries = await this.load();
			const existing = entries.get(key);
			const now = Date.now();
			const entry: MemoryEntry = {
				key,
				value: existing && existing.value.length > 0 ? `${existing.value}\n${item}` : item,
				tags: meta.tags ?? existing?.tags ?? [],
				runId: meta.runId ?? existing?.runId,
				role: meta.role ?? existing?.role,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			entries.delete(key);
			entries.set(key, entry);
			while (entries.size > this.maxEntries) {
				const oldest = entries.keys().next().value as string;
				entries.delete(oldest);
			}
			await this.save(entries);
			return entry;
		});
	}

	get(key: string): Promise<MemoryEntry | undefined> {
		return this.enqueue(async () => (await this.load()).get(key));
	}

	/** All entries, least recently written first. */
	list(): Promise<MemoryEntry[]> {
		return this.enqueue(async () => [...(await this.load()).values()]);
	}

	remove(key: string): Promise<boolean> {
		return this.enqueue(async () => {
			const entries = await this.load();
			if (!entries.delete(key)) return false;
			await this.save(entries);
			return true;
		});
	}

	/** Drop the whole project store. */
	clear(): Promise<void> {
		return this.enqueue(async () => {
			this.cache = new Map();
			await rm(this.file, { force: true });
		});
	}

	/**
	 * Case-insensitive token search over keys, values, and tags: entries
	 * matching more query tokens rank higher, recency breaks ties. An empty
	 * query returns the most recently written entries.
	 */
	read(query: string, limit = 8): Promise<MemoryEntry[]> {
		return this.enqueue(async () => {
			const all = [...(await this.load()).values()];
			const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				return all.slice(-limit).reverse();
			}
			return all
				.map((entry) => {
					const haystack = `${entry.key}\n${entry.value}\n${entry.tags.join(" ")}`.toLowerCase();
					return { entry, score: tokens.filter((token) => haystack.includes(token)).length };
				})
				.filter(({ score }) => score > 0)
				.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
				.slice(0, limit)
				.map(({ entry }) => entry);
		});
	}

	/**
	 * Persist one settled task's output under "run/<runId>/<taskId>" — the
	 * shape TeamOrchestratorOptions.memory.recordTask expects. Tasks without
	 * output (e.g. failures that never produced text) are skipped.
	 */
	async recordTask(task: MemoryTaskRecord): Promise<void> {
		if (!task.output) return;
		await this.write(`run/${task.runId}/${task.taskId}`, task.output, {
			tags: [task.role, task.status],
			runId: task.runId,
			role: task.role,
		});
	}

	/**
	 * Digest of the most recently written entries, for injecting prior-run
	 * context into a new run's root task prompts. Undefined when the store is
	 * empty, so callers can skip the section entirely.
	 */
	async bootstrapContext(limit = 10, maxValueLength = 600): Promise<string | undefined> {
		// Run-scoped board entries are transient coordination state, not durable
		// project knowledge — exclude them so they don't leak into later runs.
		const all = (await this.list()).filter((entry) => !entry.tags.includes(BOARD_TAG));
		if (all.length === 0) return undefined;
		const lines = all
			.slice(-limit)
			.reverse()
			.map((entry) => {
				const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
				return `- ${entry.key}${tags}: ${truncate(entry.value, maxValueLength)}`;
			});
		return `Shared team memory from previous runs on this project (newest first):\n${lines.join("\n")}`;
	}

	/** Serialize every store operation so concurrent agents can't interleave file writes. */
	private enqueue<T>(op: () => Promise<T>): Promise<T> {
		const next = this.chain.then(op, op);
		this.chain = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	private async load(): Promise<Map<string, MemoryEntry>> {
		if (this.cache) return this.cache;
		try {
			const raw = JSON.parse(await readFile(this.file, "utf8")) as { entries?: MemoryEntry[] };
			this.cache = new Map((raw.entries ?? []).map((entry) => [entry.key, entry]));
		} catch {
			// Missing (first use) or unreadable file: start empty instead of failing.
			this.cache = new Map();
		}
		return this.cache;
	}

	private async save(entries: Map<string, MemoryEntry>): Promise<void> {
		this.cache = entries;
		await mkdir(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		await writeFile(tmp, JSON.stringify({ project: this.project, entries: [...entries.values()] }, null, "\t"));
		await rename(tmp, this.file);
	}
}

const memoryReadParams = Type.Object({
	query: Type.String({ description: "What to look up; matched against entry keys, values, and tags" }),
	limit: Type.Optional(Type.Number({ description: "Max entries to return. Default 8" })),
});

/**
 * Tool that lets an agent search the team's shared memory — knowledge that
 * persists across runs and agents on this project.
 */
export function createMemoryReadTool(memory: TeamMemory): AgentTool<typeof memoryReadParams> {
	return {
		name: "memory_read",
		label: "Read Team Memory",
		description:
			"Search the team's shared memory: knowledge written by any agent on any run of this project, " +
			"including prior runs' task outputs. Use it to recall decisions, conventions, and results " +
			"before redoing work.",
		parameters: memoryReadParams,
		execute: async (_toolCallId, params) => {
			const matches = await memory.read(params.query, params.limit ?? 8);
			if (matches.length === 0) {
				return {
					content: [{ type: "text", text: `No memory entries match "${params.query}".` }],
					details: { matches: 0 },
				};
			}
			const text = matches
				.map((entry) => {
					const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
					return `### ${entry.key}${tags}\n${entry.value}`;
				})
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { matches: matches.length } };
		},
	};
}

const memoryWriteParams = Type.Object({
	key: Type.String({ description: "Stable identifier for the fact, e.g. 'auth/token-refresh-approach'" }),
	value: Type.String({ description: "The knowledge to remember; future runs and other agents will read this" }),
	tags: Type.Optional(Type.Array(Type.String(), { description: "Labels that make the entry easier to find" })),
});

/**
 * Tool that lets an agent write to the team's shared memory. `meta` stamps
 * entries with the writer's run/role for provenance.
 */
export function createMemoryWriteTool(memory: TeamMemory, meta: { runId?: string; role?: string } = {}): AgentTool<typeof memoryWriteParams> {
	return {
		name: "memory_write",
		label: "Write Team Memory",
		description:
			"Save knowledge to the team's shared memory so future runs and other agents can use it: " +
			"decisions made, conventions discovered, results worth keeping. Writing an existing key updates it.",
		parameters: memoryWriteParams,
		execute: async (_toolCallId, params) => {
			const entry = await memory.write(params.key, params.value, { tags: params.tags, runId: meta.runId, role: meta.role });
			return {
				content: [{ type: "text", text: `Remembered "${entry.key}".` }],
				details: { key: entry.key, tags: entry.tags },
			};
		},
	};
}

const boardPrefix = (runId: string): string => `board/${runId}/`;
const boardKey = (runId: string, key: string): string => `${boardPrefix(runId)}${key.replace(/^\/+/, "")}`;

const boardWriteParams = Type.Object({
	key: Type.String({ description: "Board entry key relative to this run, e.g. 'task/storage' or 'conflict/dup-type'" }),
	value: Type.String({ description: "Value to post; rewriting the same key replaces it" }),
});
const boardAppendParams = Type.Object({
	key: Type.String({ description: "Board list key relative to this run, e.g. 'conflicts'" }),
	item: Type.String({ description: "A line to append to the list" }),
});
const boardReadParams = Type.Object({
	prefix: Type.Optional(Type.String({ description: "Only return entries whose relative key starts with this, e.g. 'task/' or 'conflict/'" })),
});

/**
 * Tools for a per-run coordination board: a run-scoped slice of shared memory
 * (keys live under `board/<runId>/`, tagged so bootstrapContext skips them) so
 * agents on the same run share a task list and conflict list without colliding
 * with other runs or polluting future ones. board_write upserts a single key
 * (one writer per key — e.g. your own status); board_append atomically appends
 * to a shared list so many agents can add to it concurrently without clobbering
 * each other; board_read returns this run's board.
 */
export function createBoardTools(memory: TeamMemory, meta: { runId: string; role?: string }): AgentTool<any>[] {
	const tags = meta.role ? [BOARD_TAG, meta.role] : [BOARD_TAG];
	const write: AgentTool<typeof boardWriteParams> = {
		name: "board_write",
		label: "Write Board",
		description:
			"Post or update a value on this run's shared coordination board (scoped to this run only). Use it for state " +
			"with a single owner, e.g. your own status under key 'task/<your-task>'. Rewriting the same key replaces it.",
		parameters: boardWriteParams,
		execute: async (_id, params) => {
			const entry = await memory.write(boardKey(meta.runId, params.key), params.value, { tags, runId: meta.runId, role: meta.role });
			return { content: [{ type: "text", text: `Posted board entry '${params.key}'.` }], details: { key: entry.key } };
		},
	};
	const append: AgentTool<typeof boardAppendParams> = {
		name: "board_append",
		label: "Append Board",
		description:
			"Atomically append a line to a shared list on this run's coordination board, e.g. key 'conflicts'. Safe for " +
			"many agents at once — concurrent appends never overwrite each other (unlike board_write).",
		parameters: boardAppendParams,
		execute: async (_id, params) => {
			const entry = await memory.append(boardKey(meta.runId, params.key), params.item, { tags, runId: meta.runId, role: meta.role });
			return { content: [{ type: "text", text: `Appended to board list '${params.key}'.` }], details: { key: entry.key } };
		},
	};
	const read: AgentTool<typeof boardReadParams> = {
		name: "board_read",
		label: "Read Board",
		description: "Read this run's shared coordination board: entries posted by any agent on this run. Pass a prefix like 'task/' or 'conflict/' to narrow.",
		parameters: boardReadParams,
		execute: async (_id, params) => {
			const wanted = boardKey(meta.runId, params.prefix ?? "");
			const entries = (await memory.list()).filter((entry) => entry.key.startsWith(wanted));
			if (entries.length === 0) {
				return { content: [{ type: "text", text: "The board is empty." }], details: { entries: 0 } };
			}
			const text = entries
				.map((entry) => `### ${entry.key.slice(boardPrefix(meta.runId).length)}${entry.role ? ` (${entry.role})` : ""}\n${entry.value}`)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: { entries: entries.length } };
		},
	};
	return [read, write, append];
}
