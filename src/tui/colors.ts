import { getAgentSpawnConfig } from "../config/constants";

/**
 * Shared TUI color constants matching oh-my-pi dark theme (truecolor ANSI).
 */

// Foreground colors
export const FG = {
	accent: "\x1b[38;2;254;188;56m", // #febc38 gold
	border: "\x1b[38;2;23;143;185m", // #178fb9 blue
	success: "\x1b[38;2;137;210;129m", // #89d281 green
	error: "\x1b[38;2;252;58;75m", // #fc3a4b red
	warning: "\x1b[38;2;228;192;15m", // #e4c00f yellow
	dim: "\x1b[38;2;95;102;115m", // #5f6673
	muted: "\x1b[38;2;119;125;136m", // #777d88
} as const;

// Background colors
export const BG = {
	toolPending: "\x1b[48;2;29;33;41m", // #1d2129
	toolSuccess: "\x1b[48;2;22;26;31m", // #161a1f
	toolError: "\x1b[48;2;41;29;29m", // #291d1d
	statusLine: "\x1b[48;2;18;18;18m", // #121212
} as const;

// Control sequences
export const RESET = "\x1b[0m";
export const RESET_FG = "\x1b[39m";
export const BOLD = "\x1b[1m";
export const UNBOLD = "\x1b[22m";

// Box drawing (sharp)
export const BOX = {
	tl: "┌",
	tr: "┐",
	bl: "└",
	br: "┘",
	h: "─",
	v: "│",
	tR: "├",
	tL: "┤",
} as const;

// Status icons
export const ICON = {
	success: "✔",
	error: "✘",
	warning: "⚠",
	pending: "⟳",
	dot: "·",
} as const;

/** Foreground ANSI color for an agent type (falls back to dim). */
export function agentFg(agentType: string): string {
	return getAgentSpawnConfig(agentType)?.fg ?? FG.dim;
}

// Lifecycle state foreground colors (for status events in logs)
export const LIFECYCLE_FG: Record<string, string> = {
	spawning: "\x1b[38;2;184;184;0m", // #B8B800  dim yellow
	running: "\x1b[38;2;91;155;213m", // #5B9BD5  blue
	working: "\x1b[38;2;91;155;213m", // #5B9BD5  blue
	done: "\x1b[38;2;137;210;129m", // #89D281  green
	failed: "\x1b[38;2;252;58;75m", // #FC3A4B  red
	aborted: "\x1b[38;2;252;58;75m", // #FC3A4B  red
	dead: "\x1b[38;2;252;58;75m", // #FC3A4B  red
	stuck: "\x1b[38;2;255;140;0m", // #FF8C00  orange
	stopped: "\x1b[38;2;119;125;136m", // #777D88  gray
	started: "\x1b[38;2;184;184;0m", // #B8B800  dim yellow (alias of spawning)
	finished: "\x1b[38;2;137;210;129m", // #89D281  green (alias of done)
	paused: "\x1b[38;2;255;140;0m", // #FF8C00  orange (alias of stuck)
	resumed: "\x1b[38;2;91;155;213m", // #5B9BD5  blue (alias of running)
	deferred: "\x1b[38;2;255;140;0m", // #FF8C00  orange
	skipped: "\x1b[38;2;119;125;136m", // #777D88  gray
	interrupt: "\x1b[38;2;228;192;15m", // #E4C00F  yellow
};

/** Foreground ANSI color for a lifecycle state (falls back to muted). */
export function lifecycleFg(status: string): string {
	return LIFECYCLE_FG[status] ?? FG.muted;
}

const ESC = "\x1b";

function ansiSequenceEnd(text: string, start: number): number {
	const first = text[start];
	if (first === ESC) {
		const second = text[start + 1];
		if (!second) return start + 1;

		// CSI: ESC [ ... final-byte
		if (second === "[") {
			let i = start + 2;
			while (i < text.length) {
				const code = text.charCodeAt(i);
				if (code >= 0x40 && code <= 0x7e) return i + 1;
				i += 1;
			}
			return text.length;
		}

		// OSC: ESC ] ... BEL | ST
		if (second === "]") {
			let i = start + 2;
			while (i < text.length) {
				const code = text.charCodeAt(i);
				if (code === 0x07) return i + 1;
				if (code === 0x1b && text[i + 1] === "\\") return i + 2;
				i += 1;
			}
			return text.length;
		}

		// DCS/PM/APC: ESC P/^/_ ... ST
		if (second === "P" || second === "^" || second === "_") {
			let i = start + 2;
			while (i < text.length) {
				if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") return i + 2;
				i += 1;
			}
			return text.length;
		}

		// Single-character ESC sequence.
		return Math.min(text.length, start + 2);
	}

	// C1 CSI (single-byte 0x9B)
	if (first === "\x9b") {
		let i = start + 1;
		while (i < text.length) {
			const code = text.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) return i + 1;
			i += 1;
		}
		return text.length;
	}

	return -1;
}

function isCombiningCodePoint(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036f) ||
		(codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
		(codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
		(codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
		(codePoint >= 0xfe20 && codePoint <= 0xfe2f)
	);
}

function isFullWidthCodePoint(codePoint: number): boolean {
	if (codePoint < 0x1100) return false;
	return (
		codePoint <= 0x115f ||
		codePoint === 0x2329 ||
		codePoint === 0x232a ||
		(codePoint >= 0x2e80 && codePoint <= 0x3247 && codePoint !== 0x303f) ||
		(codePoint >= 0x3250 && codePoint <= 0x4dbf) ||
		(codePoint >= 0x4e00 && codePoint <= 0xa4c6) ||
		(codePoint >= 0xa960 && codePoint <= 0xa97c) ||
		(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
		(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
		(codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
		(codePoint >= 0xfe30 && codePoint <= 0xfe6b) ||
		(codePoint >= 0xff01 && codePoint <= 0xff60) ||
		(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
		(codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
		(codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
		(codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
		(codePoint >= 0x20000 && codePoint <= 0x3fffd)
	);
}

function codePointDisplayWidth(codePoint: number): number {
	if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;
	if (codePoint === 0x200d) return 0; // ZWJ
	if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0; // variation selectors
	if (isCombiningCodePoint(codePoint)) return 0;
	if (isFullWidthCodePoint(codePoint)) return 2;
	return 1;
}

/** Visible character count (ANSI-aware, terminal-column width). */
export function visibleWidth(text: string): number {
	let width = 0;
	let i = 0;

	while (i < text.length) {
		const ansiEnd = ansiSequenceEnd(text, i);
		if (ansiEnd > i) {
			i = ansiEnd;
			continue;
		}

		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;

		width += codePointDisplayWidth(codePoint);
		i += codePoint > 0xffff ? 2 : 1;
	}

	return width;
}

/** Clip text to max visible chars, appending … if truncated. */
export function clipText(value: string, max: number): string {
	if (max <= 0) return "";
	if (visibleWidth(value) <= max) return value;
	if (max <= 1) return "…";
	const target = max - 1;
	let out = "";
	let width = 0;
	let i = 0;

	while (i < value.length && width < target) {
		const ansiEnd = ansiSequenceEnd(value, i);
		if (ansiEnd > i) {
			i = ansiEnd;
			continue;
		}

		const codePoint = value.codePointAt(i);
		if (codePoint === undefined) break;

		const size = codePoint > 0xffff ? 2 : 1;
		const nextWidth = codePointDisplayWidth(codePoint);
		if (width + nextWidth > target) break;

		out += value.slice(i, i + size);
		i += size;
		width += nextWidth;
	}

	return `${out}…`;
}
/** ANSI-aware clipping to visible width. */
export function clipAnsi(text: string, width: number): string {
	if (width <= 0 || !text) return "";
	let out = "";
	let visible = 0;
	let i = 0;
	let sawAnsi = false;
	while (i < text.length && visible < width) {
		const ansiEnd = ansiSequenceEnd(text, i);
		if (ansiEnd > i) {
			out += text.slice(i, ansiEnd);
			i = ansiEnd;
			sawAnsi = true;
			continue;
		}

		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) break;

		const size = codePoint > 0xffff ? 2 : 1;
		const nextWidth = codePointDisplayWidth(codePoint);
		if (visible + nextWidth > width) break;

		out += text.slice(i, i + size);
		i += size;
		visible += nextWidth;
	}

	if (sawAnsi && !out.endsWith(RESET)) out += RESET;
	return out;
}
