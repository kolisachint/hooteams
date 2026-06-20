#!/usr/bin/env bun
import { loadConfig, startServer } from "@kolisachint/hooteams-server";
import pkg from "../package.json" with { type: "json" };
import { banner } from "./banner.js";
import { attach, cancel, init, listWorkflows, nudge, pending, plan, resume, run, runWorkflow, status, stop, work, workflowInit } from "./commands.js";

const USAGE = `hooteams — multi-agent orchestration for hoocode

Usage:
  hooteams init   [--force]                                 scaffold .agents/teams/team.json, .hooteams/rules/, AGENTS.md
  hooteams work   "<goal>" [--config p] [--model id] [--keep] [--loop] [--out f] [--host …]
                                                           plan + run a goal end-to-end (boots a server if needed)
  hooteams start  [--config path] [--port 4242] [--resume] [--allow-autonomous] [--no-webui]
                                                           start the team server + live web UI
  hooteams plan   "<goal>" [--out tasks.json] [--model id]  plan a goal without executing (dry run)
  hooteams run    <tasks.json> [--detach] [--host …]        start a task-graph run
  hooteams workflow init [--force]                          scaffold .agents/workflows/ from .agents/commands/*.md
  hooteams workflow run <name> [--detach] [--host …]        run a named .agents/workflows/<name>.json (no planner)
  hooteams workflow list [--host …]                         list available workflows
  hooteams pending [--host …]                               list approval gates awaiting an answer
  hooteams resume <taskId> "<option>" [--feedback "…"]      answer an approval gate
  hooteams attach <role> [--replay 50] [--host …]           attach this terminal to an agent
  hooteams nudge  <role> "<message>" [--host …]             inject a message mid-run
  hooteams status [--host …]                                all agents at a glance
  hooteams cancel [--host …]                                abort the active run (server keeps running)
  hooteams stop   [--host …]                                stop the server gracefully

Options:
  --host     bridge base URL (default http://localhost:4242)
  --resume   restore and continue an interrupted run on startup
  --allow-autonomous  skip the human-in-the-loop completion gate (HITL is on by default)
  --no-webui  do not serve the live web UI (served on the same port by default)
  --detach   print the run id and exit instead of following the run
  --out      write the dry-run plan to this file (hooteams run accepts it)
  --model    planner model id for hooteams plan/work (default claude-sonnet-4-5)
  --keep     (work) leave the booted server + web UI running after the run
  --loop     (work) re-plan and re-run until the goal validator verifies it
  --max-iterations  (work) cap on --loop iterations (default 3)
  --verify   (work) goal-completion validator prompt for --loop
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
		case "init":
			await init({ force: args.includes("--force") });
			break;
		case "work": {
			const goal = positional(0);
			if (!goal) throw new Error('Usage: hooteams work "<goal>" [--config p] [--model id] [--keep] [--loop] [--out f]');
			const maxIterationsFlag = readFlag("max-iterations");
			await work(host, goal, {
				config: readFlag("config"),
				model: readFlag("model"),
				provider: readFlag("provider"),
				keep: args.includes("--keep"),
				detach: args.includes("--detach"),
				allowAutonomous: args.includes("--allow-autonomous"),
				webui: args.includes("--no-webui") ? false : undefined,
				out: readFlag("out"),
				loop: args.includes("--loop"),
				maxIterations: maxIterationsFlag ? Number(maxIterationsFlag) : undefined,
				verify: readFlag("verify"),
			});
			break;
		}
		case "start": {
			const config = await loadConfig(readFlag("config"));
			const portFlag = readFlag("port");
			// The web UI ships prebuilt (`dist/`) in the published package; we never
			// build it on the user's machine (that would require devDependencies/
			// workspace binaries that aren't present in an npm/global install).
			const running = startServer(config, {
				port: portFlag ? Number(portFlag) : undefined,
				resumeInterrupted: args.includes("--resume") || undefined,
				allowAutonomous: args.includes("--allow-autonomous") || undefined,
				webui: args.includes("--no-webui") ? false : undefined,
			});
			process.stdout.write(`\n${banner(pkg.version)}\n`);
			console.log(`hooteams server listening on http://localhost:${running.port}`);
			if (running.webuiRoot) {
				console.log(`live web UI:  http://localhost:${running.port}  ← open in a browser to watch the team`);
			} else if (!args.includes("--no-webui")) {
				console.log(`web UI assets missing from this install — update to the latest release to enable live mission control`);
			}
			if (config.team.length > 0) console.log(`team: ${config.team.map((role) => role.role).join(", ")}`);
			const shutdown = async () => {
				await running.stop();
				process.exit(0);
			};
			process.on("SIGINT", () => void shutdown());
			process.on("SIGTERM", () => void shutdown());
			break;
		}
		case "plan": {
			const goal = positional(0);
			if (!goal) throw new Error('Usage: hooteams plan "<goal>" [--out tasks.json] [--model id] [--provider p]');
			await plan(goal, readFlag("out"), readFlag("model"), readFlag("provider"));
			break;
		}
		case "run": {
			const file = positional(0);
			if (!file) throw new Error("Usage: hooteams run <tasks.json>");
			await run(host, file, !args.includes("--detach"));
			break;
		}
		case "workflow": {
			const sub = positional(0);
			if (sub === "init") {
				await workflowInit({ force: args.includes("--force") });
				break;
			}
			if (sub === "list") {
				listWorkflows();
				break;
			}
			if (sub === "run") {
				const name = positional(1);
				if (!name) throw new Error("Usage: hooteams workflow run <name> [--detach]");
				await runWorkflow(host, name, !args.includes("--detach"));
				break;
			}
			throw new Error("Usage: hooteams workflow <init|run|list> [name] [--detach] [--force]");
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
		case "cancel":
			await cancel(host);
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
