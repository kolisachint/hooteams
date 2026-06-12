import { createInterface } from "node:readline/promises";
import { StreamRenderer } from "./render.js";
import { consumeSSE } from "./sse.js";

export async function nudge(host: string, role: string, message: string): Promise<void> {
	const response = await fetch(`${host}/steer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ role, message }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `HTTP ${response.status}`);
	}
	console.log(`nudged ${role} ✓`);
}

export async function status(host: string): Promise<void> {
	const response = await fetch(`${host}/status`);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const snapshot = (await response.json()) as Record<string, { status: string; lastEventType?: string }>;
	const roles = Object.keys(snapshot);
	if (roles.length === 0) {
		console.log("no agents running");
		return;
	}
	const width = Math.max(...roles.map((role) => role.length));
	for (const [role, info] of Object.entries(snapshot)) {
		const last = info.lastEventType ? `  (last: ${info.lastEventType})` : "";
		console.log(`${role.padEnd(width)}  ${info.status}${last}`);
	}
}

/**
 * POST a task graph to /runs and follow its lifecycle on /events until the
 * dag settles. The file holds { tasks: [{ id, role, prompt?, deps? }] } (a
 * bare task array is accepted too). Detaching leaves the run going.
 */
export async function run(host: string, file: string, follow: boolean): Promise<void> {
	const parsed = JSON.parse(await Bun.file(file).text()) as unknown;
	const body = Array.isArray(parsed) ? { tasks: parsed } : parsed;
	const response = await fetch(`${host}/runs`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(error.error ?? `HTTP ${response.status}`);
	}
	const { runId } = (await response.json()) as { runId: string };
	console.log(`run started: ${runId}`);
	if (!follow) return;
	console.log("following the run — ctrl-c detaches (the run keeps going)\n");

	let failed = false;
	const controller = new AbortController();
	await consumeSSE(
		`${host}/events?replay=50`,
		(event) => {
			switch (event.type) {
				case "task_started":
					console.log(`▶ ${event.taskId} (${event.role})`);
					break;
				case "task_paused":
					console.log(`⏸ ${event.taskId} needs input: ${event.question}`);
					console.log(`   options: ${(event.options ?? []).join(", ")}`);
					console.log(`   answer with: hooteams resume ${event.taskId} "<option>"`);
					break;
				case "task_resumed":
					console.log(`▶ ${event.taskId} resumed with "${event.chosenOption}"`);
					break;
				case "task_finished":
					console.log(`${event.status === "done" ? "✓" : "✗"} ${event.taskId} ${event.status}`);
					break;
				case "dag_complete":
				case "dag_failed":
					if (event.runId !== runId) break;
					failed = event.type === "dag_failed";
					console.log(`\nrun ${failed ? "failed" : "complete"}: ${runId}`);
					controller.abort();
					break;
			}
		},
		controller.signal,
	);
	if (failed) process.exit(1);
}

/** List the active run's unanswered approval gates. */
export async function pending(host: string): Promise<void> {
	const response = await fetch(`${host}/tasks/pending`);
	if (response.status === 404) {
		console.log("no active run");
		return;
	}
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const data = (await response.json()) as {
		runId: string;
		pending: Array<{ taskId: string; question: string; options: string[] }>;
	};
	if (data.pending.length === 0) {
		console.log(`run ${data.runId}: no pending approvals`);
		return;
	}
	for (const gate of data.pending) {
		console.log(`${gate.taskId}: ${gate.question}`);
		console.log(`  options: ${gate.options.join(", ")}`);
	}
}

/** Answer a paused task's approval gate. */
export async function resume(host: string, taskId: string, option: string, feedback?: string): Promise<void> {
	const response = await fetch(`${host}/tasks/${encodeURIComponent(taskId)}/resume`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ option, feedback }),
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(error.error ?? `HTTP ${response.status}`);
	}
	console.log(`resumed ${taskId} with "${option}" ✓`);
}

export async function stop(host: string): Promise<void> {
	const response = await fetch(`${host}/stop`, { method: "POST" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	console.log("server stopping");
}

/**
 * Attach this terminal to a running agent: replay recent events, follow live,
 * [n] to nudge, [q] to detach (the agent keeps running).
 */
export async function attach(host: string, role: string, replay: number): Promise<void> {
	console.log(`attached: ${role} — [q]uit  [n]udge`);
	const renderer = new StreamRenderer();
	const controller = new AbortController();

	const stdin = process.stdin;
	const interactive = stdin.isTTY === true;
	let paused = false;

	const onKey = (data: Buffer): void => {
		if (paused) return;
		const key = data.toString();
		if (key === "q" || key === "\x03") {
			controller.abort();
			cleanup();
			console.log(`\ndetached from ${role} (agent keeps running)`);
			process.exit(0);
		}
		if (key === "n") {
			paused = true;
			stdin.setRawMode?.(false);
			const readline = createInterface({ input: process.stdin, output: process.stdout });
			readline
				.question("\nnudge > ")
				.then(async (message) => {
					readline.close();
					if (message.trim().length > 0) {
						await nudge(host, role, message.trim()).catch((error) => console.error(String(error)));
					}
					stdin.setRawMode?.(true);
					paused = false;
				})
				.catch(() => {
					readline.close();
					paused = false;
				});
		}
	};

	const cleanup = (): void => {
		if (interactive) {
			stdin.setRawMode?.(false);
			stdin.off("data", onKey);
			stdin.pause();
		}
	};

	if (interactive) {
		stdin.setRawMode?.(true);
		stdin.resume();
		stdin.on("data", onKey);
	}

	try {
		await consumeSSE(`${host}/events/${encodeURIComponent(role)}?replay=${replay}`, (event) => {
			renderer.render(event);
		}, controller.signal);
		console.log("\nstream ended (server stopped)");
	} finally {
		cleanup();
	}
}
