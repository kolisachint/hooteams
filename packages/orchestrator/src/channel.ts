import { EventEmitter } from "node:events";
import type { AgentEvent, TeamEvent } from "./types.js";

export const REPLAY_BUFFER_SIZE = 100;

/**
 * Minimal surface the channel needs from an agent. `Agent` from
 * @kolisachint/hoocode-agent-core satisfies this; tests can pass fakes.
 */
export interface Subscribable {
	subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void;
}

interface ChannelEntry {
	role: string;
	agentId: string;
	buffer: TeamEvent[];
	unsubscribe: () => void;
}

export type TeamEventListener = (event: TeamEvent) => void;

/**
 * Event bus for the whole team. Wraps each agent's subscribe(), tags every
 * AgentEvent with { role, agentId, ts }, and keeps a per-agent ring buffer of
 * the last REPLAY_BUFFER_SIZE events so late subscribers (terminal attach,
 * page reload) can replay what already happened.
 */
export class TeamChannel {
	private readonly emitter = new EventEmitter();
	private readonly entries = new Map<string, ChannelEntry>();

	constructor() {
		// A team can fan out to many SSE clients; the default cap of 10 is too low.
		this.emitter.setMaxListeners(0);
	}

	/** Start mirroring an agent's events onto the team bus under `role`. */
	attach(role: string, agentId: string, agent: Subscribable): void {
		if (this.entries.has(role)) {
			throw new Error(`Channel already has an agent attached for role "${role}"`);
		}
		const entry: ChannelEntry = {
			role,
			agentId,
			buffer: [],
			unsubscribe: agent.subscribe((event) => {
				this.publish({ ...event, role, agentId, ts: Date.now() });
			}),
		};
		this.entries.set(role, entry);
	}

	/** Stop mirroring `role`. The replay buffer for the role is dropped. */
	detach(role: string): void {
		const entry = this.entries.get(role);
		if (!entry) return;
		entry.unsubscribe();
		this.entries.delete(role);
	}

	/** Emit a pre-tagged event onto the bus (used internally and for synthetic events). */
	publish(event: TeamEvent): void {
		const entry = this.entries.get(event.role);
		if (entry) {
			entry.buffer.push(event);
			if (entry.buffer.length > REPLAY_BUFFER_SIZE) {
				entry.buffer.splice(0, entry.buffer.length - REPLAY_BUFFER_SIZE);
			}
		}
		this.emitter.emit("event", event);
	}

	/** Subscribe to live events for all roles, or a single role when given. */
	subscribe(listener: TeamEventListener, role?: string): () => void {
		const wrapped: TeamEventListener = role ? (event) => event.role === role && listener(event) : listener;
		this.emitter.on("event", wrapped);
		return () => this.emitter.off("event", wrapped);
	}

	/**
	 * Snapshot of buffered events — a single role's buffer, or all roles
	 * merged in timestamp order. Replay this to a client before subscribing
	 * it to live events.
	 */
	replay(role?: string, limit = REPLAY_BUFFER_SIZE): TeamEvent[] {
		let events: TeamEvent[];
		if (role) {
			events = this.entries.get(role)?.buffer.slice() ?? [];
		} else {
			events = [...this.entries.values()].flatMap((entry) => entry.buffer).sort((a, b) => a.ts - b.ts);
		}
		return limit < events.length ? events.slice(events.length - limit) : events;
	}

	roles(): string[] {
		return [...this.entries.keys()];
	}

	agentId(role: string): string | undefined {
		return this.entries.get(role)?.agentId;
	}
}
