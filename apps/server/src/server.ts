import { createRouter, SSEBridge } from "@kolisachint/hooteams-bridge";
import { Team, TeamChannel, type TeamOptions } from "@kolisachint/hooteams-orchestrator";
import { DEFAULT_PORT, type ServerConfig } from "./config.js";

export interface RunningServer {
	server: ReturnType<typeof Bun.serve>;
	channel: TeamChannel;
	team: Team;
	bridge: SSEBridge;
	port: number;
	/** Abort all agents, drop SSE clients, and stop listening. */
	stop(): Promise<void>;
}

export interface StartOptions {
	port?: number;
	/** Forwarded to the Team (tests inject fake models / stream functions). */
	teamOptions?: TeamOptions;
}

export function startServer(config: ServerConfig, options: StartOptions = {}): RunningServer {
	const channel = new TeamChannel();
	const team = new Team(channel, options.teamOptions);
	const bridge = new SSEBridge(channel);
	const router = createRouter(team, channel, bridge);

	for (const role of config.team) {
		if (role.mcpConfigPath) {
			// MCP loading is async; spawn in the background so startup stays sync.
			// A failed role is logged and skipped instead of taking the server down.
			void team.spawnAsync(role).catch((error) => {
				console.error(`[hooteams] failed to spawn role "${role.role}": ${String(error)}`);
			});
		} else {
			team.spawn(role);
		}
	}

	let stopping = false;
	const stop = async (): Promise<void> => {
		if (stopping) return;
		stopping = true;
		await team.killAll();
		bridge.closeAll();
		server.stop(true);
	};

	const server = Bun.serve({
		port: options.port ?? config.port ?? Number(process.env.PORT ?? DEFAULT_PORT),
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/stop") {
				// stop(true) force-closes every connection including this one,
				// so give the response a moment to flush before shutting down.
				setTimeout(() => void stop(), 100);
				return Response.json({ ok: true, stopping: true });
			}
			return router.fetch(request);
		},
	});

	return { server, channel, team, bridge, port: server.port ?? 0, stop };
}
