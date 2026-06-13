import type { NodeHandle, NodeHarness } from "./team-orchestrator.js";
import type { AgentEvent, AgentMessage, TaskNode } from "./types.js";

function assistantMessage(text: string, errorMessage?: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], errorMessage, timestamp: Date.now() } as unknown as AgentMessage;
}

/**
 * Scripted, deterministic stand-in for a real AgentHarness, the team analogue
 * of the ai package's faux provider: a DAG or orchestrator test drives it with
 * queued responses instead of a live model, so the test needs no API key and
 * runs in milliseconds.
 *
 * Each prompt() consumes the next queued response — assistant text the run ends
 * on (queue a string carrying an AWAITING_APPROVAL line to open an approval
 * gate), or an Error the run rejects with. With nothing queued it echoes the
 * prompt as `did <prompt>`. prompt() resolves as soon as it has emitted the
 * run's events, so this models a run that finishes on its own; it does not hold
 * a run open for mid-run steering (steer() is still recorded for assertions).
 */
export class FakeNodeHarness implements NodeHarness {
	/** Prompts received, in dispatch order. */
	readonly prompts: string[] = [];
	/** Steering messages received, in order. */
	readonly steers: string[] = [];
	private readonly responses: Array<string | Error> = [];
	private readonly listeners = new Set<(event: AgentEvent) => Promise<void> | void>();

	/** Script the outcome of the next prompt: assistant text, or an Error it rejects with. */
	queue(response: string | Error): this {
		this.responses.push(response);
		return this;
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		const response = this.responses.shift() ?? `did ${text}`;
		if (response instanceof Error) {
			throw response;
		}
		const message = assistantMessage(response);
		await this.emit({ type: "message_end", message } as AgentEvent);
		await this.emit({ type: "agent_end", messages: [message] } as AgentEvent);
	}

	steer(text: string): void {
		this.steers.push(text);
	}

	subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async emit(event: AgentEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}
}

/**
 * Build a TeamOrchestratorOptions.createHarness that returns one FakeNodeHarness
 * per node, optionally pre-seeded by `script` (queue responses, inspect the
 * node). The handle reports a deterministic `session-<id>` sessionId so trace
 * assertions have something stable to match.
 */
export function fakeHarnessFactory(
	script?: (node: TaskNode, harness: FakeNodeHarness) => void,
): (node: TaskNode) => NodeHandle {
	return (node: TaskNode): NodeHandle => {
		const harness = new FakeNodeHarness();
		script?.(node, harness);
		return { harness, sessionId: `session-${node.id}` };
	};
}
