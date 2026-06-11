import { Agent, type StreamFn } from "@kolisachint/hoocode-agent-core";
import { getModel, type Model } from "@kolisachint/hoocode-ai";
import { randomUUID } from "node:crypto";
import type { TeamChannel } from "./channel.js";
import type { AgentStatus, RoleConfig, TeamEvent } from "./types.js";

export interface TeamOptions {
	/** Override model lookup (tests inject fakes here). Defaults to getModel(provider, model). */
	resolveModel?: (config: RoleConfig) => Model<any>;
	/** Forwarded to every spawned Agent; lets tests stub the LLM. */
	streamFn?: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

interface TeamMember {
	role: string;
	agentId: string;
	agent: Agent;
	config: RoleConfig;
	status: AgentStatus;
}

/**
 * Registry of live agents, one per role. Spawning attaches the agent to the
 * TeamChannel so every event it emits lands on the shared bus tagged with its
 * role; killing aborts the run and detaches it.
 */
export class Team {
	private readonly members = new Map<string, TeamMember>();

	constructor(
		readonly channel: TeamChannel,
		private readonly options: TeamOptions = {},
	) {
		channel.subscribe((event) => this.trackStatus(event));
	}

	spawn(config: RoleConfig): Agent {
		if (this.members.has(config.role)) {
			throw new Error(`Team already has an agent for role "${config.role}"`);
		}
		const model = this.options.resolveModel
			? this.options.resolveModel(config)
			: getModel((config.provider ?? "anthropic") as any, config.model as any);
		if (!model) {
			throw new Error(`Unknown model "${config.model}" for provider "${config.provider ?? "anthropic"}"`);
		}
		const agent = new Agent({
			initialState: {
				systemPrompt: config.systemPrompt,
				model,
				thinkingLevel: config.thinkingLevel ?? "off",
			},
			streamFn: this.options.streamFn,
			getApiKey: this.options.getApiKey,
		});
		const agentId = randomUUID();
		this.channel.attach(config.role, agentId, agent);
		this.members.set(config.role, { role: config.role, agentId, agent, config, status: "idle" });
		return agent;
	}

	get(role: string): Agent | undefined {
		return this.members.get(role)?.agent;
	}

	has(role: string): boolean {
		return this.members.has(role);
	}

	roles(): string[] {
		return [...this.members.keys()];
	}

	/**
	 * Send a message into an agent (the "nudge"). Mid-run it queues as a
	 * steering message; on an idle agent it starts or resumes a run so the
	 * nudge is actually read.
	 */
	steer(role: string, text: string): void {
		const member = this.members.get(role);
		if (!member) {
			throw new Error(`No agent for role "${role}"`);
		}
		const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
		if (member.agent.state.isStreaming) {
			member.agent.steer(message);
			return;
		}
		if (member.agent.state.messages.length === 0) {
			void member.agent.prompt(message).catch(() => {});
			return;
		}
		member.agent.steer(message);
		void member.agent.continue().catch(() => {});
	}

	/** Abort the agent's run and remove it from the team. */
	kill(role: string): void {
		const member = this.members.get(role);
		if (!member) return;
		member.agent.abort();
		this.channel.detach(role);
		this.members.delete(role);
	}

	async killAll(): Promise<void> {
		const idle = [...this.members.values()].map((member) => {
			member.agent.abort();
			return member.agent.waitForIdle();
		});
		for (const role of this.roles()) {
			this.channel.detach(role);
			this.members.delete(role);
		}
		await Promise.all(idle);
	}

	status(): Record<string, AgentStatus> {
		const snapshot: Record<string, AgentStatus> = {};
		for (const [role, member] of this.members) {
			snapshot[role] = member.status;
		}
		return snapshot;
	}

	private trackStatus(event: TeamEvent): void {
		const member = this.members.get(event.role);
		if (!member) return;
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				member.status = "thinking";
				break;
			case "message_update":
				member.status = event.assistantMessageEvent.type.startsWith("thinking") ? "thinking" : "streaming";
				break;
			case "tool_execution_start":
				member.status = "tool";
				break;
			case "tool_execution_end":
				member.status = "thinking";
				break;
			case "turn_end":
				if (event.message.role === "assistant" && event.message.errorMessage) {
					member.status = "error";
				}
				break;
			case "agent_end":
				if (member.status !== "error") {
					member.status = "done";
				}
				break;
		}
	}
}
