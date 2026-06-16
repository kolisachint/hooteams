import type { TeamChannel } from "@kolisachint/hooteams-orchestrator";
import { serializeTeamEvent } from "./serializer.js";

const encoder = new TextEncoder();

/**
 * How often to send an SSE comment heartbeat (`: ping`) on an otherwise idle
 * stream. A quiet run (e.g. a node paused on a human gate, or the gap between
 * agent turns) sends no events for long stretches; without a heartbeat the
 * browser or an intervening proxy drops the connection, the client flips to
 * "reconnecting", replays, goes quiet, and drops again — a perpetual flap. A
 * comment frame keeps the pipe warm and is ignored by EventSource.onmessage.
 */
const HEARTBEAT_MS = 15_000;

/** A single SSE comment frame; ignored by EventSource, keeps the stream alive. */
const HEARTBEAT_FRAME = encoder.encode(": ping\n\n");

interface SSEClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	unsubscribe: () => void;
	/** Stops the heartbeat and detaches this client; idempotent. */
	teardown: () => void;
}

/**
 * Fans the TeamChannel out to any number of SSE clients. Each stream first
 * replays the channel's ring buffer (the `tmux attach` feel), then follows
 * live events until the client disconnects.
 */
export class SSEBridge {
	private readonly clients = new Set<SSEClient>();
	private readonly heartbeatMs: number;

	constructor(
		private readonly channel: TeamChannel,
		/** Heartbeat interval in ms; defaults to HEARTBEAT_MS. Lowered in tests. */
		heartbeatMs: number = HEARTBEAT_MS,
	) {
		this.heartbeatMs = heartbeatMs;
	}

	/** Body for an SSE response. `role` scopes to one agent; omit for the whole team. */
	stream(role?: string, replayLimit?: number): ReadableStream<Uint8Array> {
		const channel = this.channel;
		const clients = this.clients;
		const heartbeatMs = this.heartbeatMs;
		let client: SSEClient | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;

		const teardown = () => {
			if (heartbeat) {
				clearInterval(heartbeat);
				heartbeat = undefined;
			}
			if (client) {
				client.unsubscribe();
				clients.delete(client);
				client = undefined;
			}
		};

		return new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of channel.replay(role, replayLimit)) {
					controller.enqueue(encoder.encode(serializeTeamEvent(event)));
				}
				const unsubscribe = channel.subscribe((event) => {
					try {
						controller.enqueue(encoder.encode(serializeTeamEvent(event)));
					} catch {
						// Client went away mid-enqueue; cancel() handles cleanup.
					}
				}, role);
				client = { controller, unsubscribe, teardown };
				clients.add(client);
				// Keep idle streams alive (see HEARTBEAT_MS). A failed enqueue means
				// the client is gone; tear down so we stop pinging a dead socket.
				heartbeat = setInterval(() => {
					try {
						controller.enqueue(HEARTBEAT_FRAME);
					} catch {
						teardown();
					}
				}, heartbeatMs);
			},
			cancel() {
				teardown();
			},
		});
	}

	get clientCount(): number {
		return this.clients.size;
	}

	/** Disconnect every client (used for graceful shutdown). */
	closeAll(): void {
		// Snapshot first: teardown() mutates this.clients while we iterate.
		for (const client of [...this.clients]) {
			client.teardown();
			try {
				client.controller.close();
			} catch {
				// already closed
			}
		}
		this.clients.clear();
	}
}
