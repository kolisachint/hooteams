/**
 * Shared ecosystem boot card for the hooteams CLI.
 *
 * The block-glyph owl is the *shared* terminal mark for the whole hoo
 * ecosystem (hoocode / hooteams / hoocowork); only the `hoo│suffix` line and
 * descriptor differ. The canonical generator + ANSI source lives in the
 * `hoo-brand` repo (`assets/tui/hooteams.ans`, `scripts/build_banner.py`); it
 * is reproduced here so the published CLI carries no cross-repo asset
 * dependency. Keep the two in sync if the mark changes.
 */

// Signal Cyan #00F0FF — the ecosystem accent (the owl's eyes / `oo` nodes).
const CYAN = "\x1b[38;2;0;240;255m";
const WHITE = "\x1b[97m";
const DIM = "\x1b[38;2;113;113;122m"; // zinc-500
const RESET = "\x1b[0m";

// Three-row owl: flat square blot, dome eyes (`▟▙ ▟▙`) are the `oo` nodes.
const OWL = ["▟▀▀▀▀▀▙", "▌▟▙ ▟▙▐", "▜▄▄▄▄▄▛"] as const;

/** True when ANSI color should be suppressed (NO_COLOR, or stdout is not a TTY). */
function colorDisabled(): boolean {
	return Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
}

/**
 * Render the hooteams boot card. Falls back to a plain, alignment-safe owl on
 * terminals without truecolor (NO_COLOR / non-TTY pipes).
 */
export function banner(version: string): string {
	const suffix = "teams";
	const descriptor = "multi-agent orchestration";
	const cwd = process.cwd();

	const info = [`hoo│${suffix}`, descriptor, `v${version} · ${cwd}`];

	if (colorDisabled()) {
		return OWL.map((row, i) => `${row}  ${info[i]}`).join("\n") + "\n";
	}

	const owlColor = [
		`${WHITE}${OWL[0]}${RESET}`,
		`${WHITE}▌${RESET}${CYAN}▟▙ ▟▙${RESET}${WHITE}▐${RESET}`,
		`${WHITE}${OWL[2]}${RESET}`,
	];
	const infoColor = [
		`${WHITE}hoo${DIM}│${RESET}${CYAN}${suffix}${RESET}`,
		`${DIM}${descriptor}${RESET}`,
		`${DIM}v${version} · ${cwd}${RESET}`,
	];

	return owlColor.map((row, i) => `${row}  ${infoColor[i]}`).join("\n") + "\n";
}
