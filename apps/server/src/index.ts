#!/usr/bin/env bun
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

function readFlag(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index !== -1 ? process.argv[index + 1] : undefined;
}

const config = await loadConfig(readFlag("config"));
const portFlag = readFlag("port");
const running = startServer(config, { port: portFlag ? Number(portFlag) : undefined });

console.log(`hooteams server listening on http://localhost:${running.port}`);
if (running.webuiRoot) {
	console.log(`  live web UI             http://localhost:${running.port}/`);
}
console.log(`  GET  /events            all-agent SSE stream`);
console.log(`  GET  /events/:role      single-agent SSE stream (replay + live)`);
console.log(`  POST /steer             { role, message }`);
console.log(`  GET  /status            agent status snapshot`);
console.log(`  GET  /health            liveness probe`);
if (config.team.length > 0) {
	console.log(`team: ${config.team.map((role) => role.role).join(", ")}`);
}

async function shutdown(signal: string): Promise<void> {
	console.log(`\n${signal} received, aborting agents…`);
	await running.stop();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
