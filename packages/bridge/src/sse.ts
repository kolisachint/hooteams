import type { TeamChannel } from "@kolisachint/hooteams-orchestrator";
import { serializeTeamEvent } from "./serializer.js";

const encoder = new TextEncoder();

interface SSEClient {
	controller: ReadableStreamDefaultController<Uint8Array>;
	unsubscribe: () => void;
}

/**
 * Fans the TeamChannel out to any number of SSE clients. Each stream first
 * replays the channel's ring buffer (the `tmux attach` feel), then follows
 * live events until the client disconnects.
 */
export class SSEBridge {
	private readonly clients = new Set<SSEClient>();

	constructor(private readonly channel: TeamChannel) {}

	/** Body for an SSE response. `role` scopes to one agent; omit for the whole team. */
	stream(role?: string, replayLimit?: number): ReadableStream<Uint8Array> {
		const channel = this.channel;
		const clients = this.clients;
		let client: SSEClient | undefined;

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
				client = { controller, unsubscribe };
				clients.add(client);
			},
			cancel() {
				if (client) {
					client.unsubscribe();
					clients.delete(client);
				}
			},
		});
	}

	get clientCount(): number {
		return this.clients.size;
	}

	/** Disconnect every client (used for graceful shutdown). */
	closeAll(): void {
		for (const client of this.clients) {
			client.unsubscribe();
			try {
				client.controller.close();
			} catch {
				// already closed
			}
		}
		this.clients.clear();
	}
}
