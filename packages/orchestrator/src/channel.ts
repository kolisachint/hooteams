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
 *
 * Events whose role has no attached agent — the orchestrator's run-level
 * events (dag_snapshot, task_*, team_error under role "orchestrator") and
 * adopted dag-node events the orchestrator mirrors directly — are buffered too,
 * in a parallel per-role ring. Without this they fan out live but vanish from
 * replay(), so a refreshing/reconnecting web UI never sees the task graph again.
 */
export class TeamChannel {
	private readonly emitter = new EventEmitter();
	private readonly entries = new Map<string, ChannelEntry>();
	/**
	 * Ring buffers for events whose role has no attached agent (e.g. the
	 * orchestrator's "orchestrator" run-level role, or dag nodes registered via
	 * Team.adopt rather than attach). Keyed by role and capped like the
	 * per-agent buffers, so replay() can re-emit them to late subscribers.
	 */
	private readonly unattachedBuffers = new Map<string, TeamEvent[]>();

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
		// Buffer into the attached agent's ring when there is one; otherwise into
		// the role's unattached ring (run-level/orchestrator + adopted dag nodes),
		// so replay() carries these to reconnecting clients instead of dropping them.
		const buffer = this.entries.get(event.role)?.buffer ?? this.unattachedBufferFor(event.role);
		buffer.push(event);
		if (buffer.length > REPLAY_BUFFER_SIZE) {
			buffer.splice(0, buffer.length - REPLAY_BUFFER_SIZE);
		}
		this.emitter.emit("event", event);
	}

	/** The ring buffer for a role with no attached agent, created on first use. */
	private unattachedBufferFor(role: string): TeamEvent[] {
		let buffer = this.unattachedBuffers.get(role);
		if (!buffer) {
			buffer = [];
			this.unattachedBuffers.set(role, buffer);
		}
		return buffer;
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
			// A role can have both an attached buffer and an unattached one (e.g. it
			// published before being spawned); merge both in timestamp order.
			const attached = this.entries.get(role)?.buffer ?? [];
			const unattached = this.unattachedBuffers.get(role) ?? [];
			events = [...attached, ...unattached].sort((a, b) => a.ts - b.ts);
		} else {
			events = [
				...[...this.entries.values()].flatMap((entry) => entry.buffer),
				...[...this.unattachedBuffers.values()].flat(),
			].sort((a, b) => a.ts - b.ts);
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
