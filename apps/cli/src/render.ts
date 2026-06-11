const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const BOLD = "\x1b[1m";
const TEAL = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

function argsPreview(args: unknown, max = 60): string {
	const text = JSON.stringify(args) ?? "";
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Minimal line renderer for a TeamEvent stream: streaming text inline,
 * thinking dimmed, tool lifecycle as ◉ lines. Tracks whether the cursor is
 * mid-line so block events start cleanly.
 */
export class StreamRenderer {
	private midLine = false;

	constructor(private readonly write: (text: string) => void = (text) => process.stdout.write(text)) {}

	private breakLine(): void {
		if (this.midLine) {
			this.write("\n");
			this.midLine = false;
		}
	}

	render(event: any): void {
		switch (event.type) {
			case "agent_start":
				this.breakLine();
				this.write(`${TEAL}◉ ${event.role} started${RESET}\n`);
				break;
			case "message_update": {
				const delta = event.assistantMessageEvent;
				if (!delta) break;
				if (delta.type === "thinking_start") {
					this.breakLine();
					this.write(`${DIM}◉ thinking…${RESET}\n`);
				} else if (delta.type === "thinking_delta") {
					this.write(`${DIM}${ITALIC}${delta.delta}${RESET}`);
					this.midLine = true;
				} else if (delta.type === "thinking_end") {
					this.breakLine();
				} else if (delta.type === "text_delta") {
					this.write(delta.delta);
					this.midLine = true;
				} else if (delta.type === "text_end") {
					this.breakLine();
				}
				break;
			}
			case "tool_execution_start":
				this.breakLine();
				this.write(`${TEAL}◉ tool: ${BOLD}${event.toolName}${RESET}${TEAL}(${argsPreview(event.args)})${RESET} ${YELLOW}running…${RESET}\n`);
				break;
			case "tool_execution_end":
				this.breakLine();
				this.write(
					event.isError
						? `${RED}  ✗ ${event.toolName} failed${RESET}\n`
						: `${GREEN}  ✓ ${event.toolName} done${RESET}\n`,
				);
				break;
			case "turn_end": {
				this.breakLine();
				const usage = event.message?.usage;
				if (usage) {
					const cost = usage.cost?.total ? ` $${usage.cost.total.toFixed(4)}` : "";
					this.write(`${DIM}— turn: ${usage.input ?? 0} in / ${usage.output ?? 0} out tokens${cost}${RESET}\n`);
				}
				if (event.message?.errorMessage) {
					this.write(`${RED}error: ${event.message.errorMessage}${RESET}\n`);
				}
				break;
			}
			case "agent_end":
				this.breakLine();
				this.write(`${TEAL}◉ ${event.role} idle${RESET}\n`);
				break;
		}
	}
}
