#!/usr/bin/env bun
import { loadConfig, startServer } from "@kolisachint/hooteams-server";
import { attach, nudge, pending, resume, run, status, stop } from "./commands.js";

const USAGE = `hooteams — multi-agent orchestration for hoocode

Usage:
  hooteams start  [--config path] [--port 4242] [--resume]  start the team server
  hooteams run    <tasks.json> [--detach] [--host …]        start a task-graph run
  hooteams pending [--host …]                               list approval gates awaiting an answer
  hooteams resume <taskId> "<option>" [--feedback "…"]      answer an approval gate
  hooteams attach <role> [--replay 50] [--host …]           attach this terminal to an agent
  hooteams nudge  <role> "<message>" [--host …]             inject a message mid-run
  hooteams status [--host …]                                all agents at a glance
  hooteams stop   [--host …]                                stop the server gracefully

Options:
  --host     bridge base URL (default http://localhost:4242)
  --resume   restore and continue an interrupted run on startup
  --detach   print the run id and exit instead of following the run
`;

const args = process.argv.slice(2);
const command = args[0];

function readFlag(name: string, fallback?: string): string | undefined {
	const index = args.indexOf(`--${name}`);
	return index !== -1 ? args[index + 1] : fallback;
}

function positional(at: number): string | undefined {
	let seen = 0;
	for (let i = 1; i < args.length; i++) {
		if (args[i]!.startsWith("--")) {
			i++; // skip the flag's value
			continue;
		}
		if (seen === at) return args[i];
		seen++;
	}
	return undefined;
}

const host = readFlag("host", "http://localhost:4242")!.replace(/\/+$/, "");

try {
	switch (command) {
		case "start": {
			const config = await loadConfig(readFlag("config"));
			const portFlag = readFlag("port");
			const running = startServer(config, {
				port: portFlag ? Number(portFlag) : undefined,
				resumeInterrupted: args.includes("--resume") || undefined,
			});
			console.log(`hooteams server listening on http://localhost:${running.port}`);
			if (config.team.length > 0) console.log(`team: ${config.team.map((role) => role.role).join(", ")}`);
			const shutdown = async () => {
				await running.stop();
				process.exit(0);
			};
			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());
			break;
		}
		case "run": {
			const file = positional(0);
			if (!file) throw new Error("Usage: hooteams run <tasks.json>");
			await run(host, file, !args.includes("--detach"));
			break;
		}
		case "pending":
			await pending(host);
			break;
		case "resume": {
			const taskId = positional(0);
			const option = positional(1);
			if (!taskId || !option) throw new Error('Usage: hooteams resume <taskId> "<option>"');
			await resume(host, taskId, option, readFlag("feedback"));
			break;
		}
		case "attach": {
			const role = positional(0);
			if (!role) throw new Error("Usage: hooteams attach <role>");
			await attach(host, role, Number(readFlag("replay", "100")));
			break;
		}
		case "nudge": {
			const role = positional(0);
			const message = positional(1);
			if (!role || !message) throw new Error('Usage: hooteams nudge <role> "<message>"');
			await nudge(host, role, message);
			break;
		}
		case "status":
			await status(host);
			break;
		case "stop":
			await stop(host);
			break;
		case undefined:
		case "help":
		case "--help":
			console.log(USAGE);
			break;
		default:
			console.error(`Unknown command: ${command}\n`);
			console.log(USAGE);
			process.exit(1);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
