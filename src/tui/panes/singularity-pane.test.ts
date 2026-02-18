import { describe, expect, test } from "bun:test";
import type { Terminal } from "@xterm/headless";
import * as xtermHeadless from "@xterm/headless";

import {
	buildSingularityPtyEnv,
	renderBufferLineAnsi,
	SingularityPane,
	viewportHasRenderableText,
} from "./singularity-pane";

type XTermCtor = new (options: {
	allowProposedApi: boolean;
	cols: number;
	rows: number;
	convertEol: boolean;
	scrollback: number;
}) => Terminal;

type XTermHeadlessModule = {
	default?: {
		Terminal?: XTermCtor;
	};
};

type BufferLineLike = {
	getCell: (x: number, cell: any) => any;
};

type RenderSink = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

const XTERM_COLOR_MODE_ANSI16 = 1 << 24;
const XTERM_COLOR_MODE_PALETTE256 = 2 << 24;
const XTERM_COLOR_MODE_RGB = 3 << 24;

function createTerminal(cols: number, rows: number): Terminal {
	const XTerm = (xtermHeadless as unknown as XTermHeadlessModule).default?.Terminal;
	if (!XTerm) throw new Error("@xterm/headless Terminal export not found");

	return new XTerm({
		allowProposedApi: true,
		cols,
		rows,
		convertEol: true,
		scrollback: 2000,
	});
}

async function writeTerm(term: Terminal, text: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	term.write(text, () => resolve());
	await promise;
}

function getViewportLine(term: Terminal): { line: BufferLineLike; nullCell: any } {
	const buffer = term.buffer.active;
	const line = buffer.getLine(buffer.viewportY);
	if (!line || typeof line.getCell !== "function") {
		throw new Error("Expected viewport line with getCell()");
	}
	return { line, nullCell: buffer.getNullCell() };
}

async function roundTripFirstLine(
	input: string,
	cols = 40,
): Promise<{
	sourceLine: BufferLineLike;
	sourceNullCell: any;
	roundTripLine: BufferLineLike;
	roundTripNullCell: any;
}> {
	const source = createTerminal(cols, 4);
	await writeTerm(source, `${input}\n`);
	const { line: sourceLine, nullCell: sourceNullCell } = getViewportLine(source);

	const rendered = renderBufferLineAnsi(sourceLine, sourceNullCell, cols);

	const roundTrip = createTerminal(cols, 4);
	await writeTerm(roundTrip, `${rendered}\n`);
	const { line: roundTripLine, nullCell: roundTripNullCell } = getViewportLine(roundTrip);

	return { sourceLine, sourceNullCell, roundTripLine, roundTripNullCell };
}

async function renderPaneLines(pane: SingularityPane, cols: number, rows: number): Promise<string[]> {
	let out = "";
	const sink = ((text: string) => {
		out += text;
	}) as RenderSink;
	sink.moveTo = (x: number, y: number) => {
		out += `\x1b[${y};${x}H`;
	};
	pane.render(sink, {
		x: 1,
		y: 1,
		width: cols,
		height: rows,
	});
	const display = createTerminal(cols, rows);
	await writeTerm(display, out);
	const buffer = display.buffer.active;
	const startY = buffer.viewportY;
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		lines.push(buffer.getLine(startY + row)?.translateToString(true) ?? "");
	}
	return lines;
}

function stripSgr(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("viewportHasRenderableText", () => {
	test("detects visible output below the sixth row", async () => {
		const term = createTerminal(80, 20);
		await writeTerm(term, `${"\n".repeat(12)}hello\n`);

		expect(viewportHasRenderableText(term, 20)).toBe(true);
	});

	test("returns false when viewport contains only blank lines", async () => {
		const term = createTerminal(80, 20);
		await writeTerm(term, "\n\n\n\n");

		expect(viewportHasRenderableText(term, 20)).toBe(false);
	});
});

describe("buildSingularityPtyEnv", () => {
	test("pins terminal size and color capability keys", () => {
		const env = buildSingularityPtyEnv(
			{
				PATH: "/usr/bin",
				COLUMNS: "120",
				LINES: "80",
				TERM: "dumb",
				COLORTERM: "falsecolor",
			},
			{
				COLUMNS: "200",
				LINES: "100",
				TERM: "screen",
				CUSTOM_FLAG: "1",
			},
			40,
			10,
		);

		expect(env.COLUMNS).toBe("40");
		expect(env.LINES).toBe("10");
		expect(env.TERM).toBe("xterm-256color");
		expect(env.COLORTERM).toBe("truecolor");
		expect(env.CUSTOM_FLAG).toBe("1");
	});
});

describe("SingularityPane PTY sizing", () => {
	test("renders intact box lines even when inherited COLUMNS/LINES are oversized", async () => {
		const cols = 40;
		const rows = 8;
		const script = [
			"const width = Number(process.env.COLUMNS || process.stdout.columns || 80);",
			"const inner = Math.max(0, width - 2);",
			'const top = "┌" + "─".repeat(inner) + "┐";',
			'const mid = "│" + "X".repeat(inner) + "│";',
			'const bottom = "└" + "─".repeat(inner) + "┘";',
			'process.stdout.write(top + "\\r\\n" + mid + "\\r\\n" + bottom + "\\r\\n");',
			"setTimeout(() => process.exit(0), 5_000);",
		].join(" ");

		const pane = new SingularityPane({
			ompCli: "bun",
			args: ["-e", script],
			cwd: process.cwd(),
			cols,
			rows,
			env: {
				COLUMNS: "120",
				LINES: "80",
			},
		});

		pane.start();
		try {
			let lines: string[] = [];
			const expectedTop = `┌${"─".repeat(cols - 2)}┐`;
			const expectedMiddle = `│${"X".repeat(cols - 2)}│`;
			const expectedBottom = `└${"─".repeat(cols - 2)}┘`;

			for (let attempt = 0; attempt < 60; attempt += 1) {
				await Bun.sleep(50);
				lines = await renderPaneLines(pane, cols, rows);
				if (lines[0] === expectedTop && lines[1] === expectedMiddle && lines[2] === expectedBottom) {
					break;
				}
			}

			expect(lines[0]).toBe(expectedTop);
			expect(lines[1]).toBe(expectedMiddle);
			expect(lines[2]).toBe(expectedBottom);
		} finally {
			pane.stop();
		}
	});
});
describe("renderBufferLineAnsi", () => {
	test("preserves ANSI 16-color foreground/background modes", async () => {
		const { sourceLine, sourceNullCell, roundTripLine, roundTripNullCell } =
			await roundTripFirstLine("\x1b[31;44mA\x1b[0m");
		const sourceCell = sourceLine.getCell(0, sourceNullCell);
		const roundTripCell = roundTripLine.getCell(0, roundTripNullCell);

		expect(sourceCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_ANSI16);
		expect(sourceCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_ANSI16);
		expect(roundTripCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_ANSI16);
		expect(roundTripCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_ANSI16);
		expect(roundTripCell.getFgColor()).toBe(sourceCell.getFgColor());
		expect(roundTripCell.getBgColor()).toBe(sourceCell.getBgColor());
	});

	test("preserves 256-color foreground/background modes", async () => {
		const { sourceLine, sourceNullCell, roundTripLine, roundTripNullCell } = await roundTripFirstLine(
			"\x1b[38;5;196;48;5;22mA\x1b[0m",
		);
		const sourceCell = sourceLine.getCell(0, sourceNullCell);
		const roundTripCell = roundTripLine.getCell(0, roundTripNullCell);

		expect(sourceCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_PALETTE256);
		expect(sourceCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_PALETTE256);
		expect(roundTripCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_PALETTE256);
		expect(roundTripCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_PALETTE256);
		expect(roundTripCell.getFgColor()).toBe(sourceCell.getFgColor());
		expect(roundTripCell.getBgColor()).toBe(sourceCell.getBgColor());
	});

	test("preserves truecolor foreground/background modes", async () => {
		const { sourceLine, sourceNullCell, roundTripLine, roundTripNullCell } = await roundTripFirstLine(
			"\x1b[38;2;1;2;3;48;2;4;5;6mA\x1b[0m",
		);
		const sourceCell = sourceLine.getCell(0, sourceNullCell);
		const roundTripCell = roundTripLine.getCell(0, roundTripNullCell);

		expect(sourceCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_RGB);
		expect(sourceCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_RGB);
		expect(roundTripCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_RGB);
		expect(roundTripCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_RGB);
		expect(roundTripCell.getFgColor()).toBe(sourceCell.getFgColor());
		expect(roundTripCell.getBgColor()).toBe(sourceCell.getBgColor());
	});

	test("sets explicit foreground when source cells have non-default background and default foreground", async () => {
		const cols = 40;
		const source = createTerminal(cols, 4);
		await writeTerm(source, "\x1b[48;2;22;22;30mTitle\x1b[0m\n");
		const { line, nullCell } = getViewportLine(source);
		const reconstructed = renderBufferLineAnsi(line, nullCell, cols);

		expect(reconstructed).toContain("\x1b[0;97;48;2;22;22;30m");

		const roundTrip = createTerminal(cols, 4);
		await writeTerm(roundTrip, `${reconstructed}\n`);
		const { line: roundTripLine, nullCell: roundTripNullCell } = getViewportLine(roundTrip);
		const roundTripCell = roundTripLine.getCell(0, roundTripNullCell);

		expect(roundTripCell.getBgColorMode()).toBe(XTERM_COLOR_MODE_RGB);
		expect(roundTripCell.getFgColorMode()).toBe(XTERM_COLOR_MODE_ANSI16);
		expect(roundTripCell.getFgColor()).toBe(15);
	});

	test("keeps emoji status lines width-stable against xterm width mismatches", async () => {
		const cols = 40;
		const left = "│ ⏳ task running";
		const right = "│";
		const direct = `${left}${" ".repeat(Math.max(0, cols - Bun.stringWidth(left) - Bun.stringWidth(right)))}${right}`;

		const source = createTerminal(cols, 4);
		await writeTerm(source, `${direct}\n`);
		const { line, nullCell } = getViewportLine(source);

		const reconstructed = renderBufferLineAnsi(line, nullCell, cols);
		const reconstructedPlain = stripSgr(reconstructed);

		expect(Bun.stringWidth(direct)).toBe(cols);
		expect(Bun.stringWidth(reconstructedPlain)).toBe(cols);
		expect(reconstructedPlain).toBe(direct);
	});

	test("preserves blink transitions between adjacent styled cells", async () => {
		const { sourceLine, sourceNullCell, roundTripLine, roundTripNullCell } =
			await roundTripFirstLine("\x1b[31;5mA\x1b[25mB\x1b[0m");
		const sourceBlinkCell = sourceLine.getCell(0, sourceNullCell);
		const sourcePlainCell = sourceLine.getCell(1, sourceNullCell);
		const roundTripBlinkCell = roundTripLine.getCell(0, roundTripNullCell);
		const roundTripPlainCell = roundTripLine.getCell(1, roundTripNullCell);

		expect(Boolean(sourceBlinkCell.isBlink())).toBe(true);
		expect(Boolean(sourcePlainCell.isBlink())).toBe(false);
		expect(Boolean(roundTripBlinkCell.isBlink())).toBe(true);
		expect(Boolean(roundTripPlainCell.isBlink())).toBe(false);
	});
});
