import type { Terminal } from "@xterm/headless";
import * as xtermHeadless from "@xterm/headless";
import type { ThinkingLevel } from "../../config";
import { logger } from "../../utils";
import { PtyBridge } from "../pty-bridge";

type TerminalLike = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

export type Region = { x: number; y: number; width: number; height: number };

function clipPad(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length > width) return text.slice(0, width);
	if (text.length < width) return text + " ".repeat(width - text.length);
	return text;
}

function keyDataToString(data: any): string | null {
	if (!data) return null;
	const code = data.code;

	if (typeof code === "string") return code;
	if (typeof code === "number") return String.fromCharCode(code);
	if (code && typeof Buffer !== "undefined" && Buffer.isBuffer(code)) {
		return code.toString("utf8");
	}
	return null;
}

export class SingularityPane {
	readonly #ompCli: string;
	readonly #args: string[];
	readonly #cwd: string;
	readonly #onDirty?: () => void;

	readonly #extensions: string[];
	readonly #extraEnv?: Record<string, string>;

	readonly #model?: string;
	readonly #thinking?: ThinkingLevel;
	readonly #tools?: string;

	#pty: PtyBridge | null = null;
	#term: Terminal;

	#lastError: string | null = null;
	#exited: { exitCode?: number; signal?: number } | null = null;

	#startedAt: number | null = null;
	#startCmd: string[] | null = null;
	#hasOutput = false;

	#cols: number;
	#rows: number;

	constructor(opts: {
		ompCli: string;
		cwd: string;
		cols: number;
		rows: number;
		model?: string;
		thinking?: ThinkingLevel;
		tools?: string;
		extensions?: string[];
		env?: Record<string, string>;
		args?: string[];
		onDirty?: () => void;
	}) {
		this.#ompCli = opts.ompCli;
		this.#cwd = opts.cwd;
		this.#args = opts.args ?? [];
		this.#onDirty = opts.onDirty;

		this.#model = opts.model;
		this.#thinking = opts.thinking;
		this.#tools = opts.tools;
		this.#extensions = Array.isArray(opts.extensions) ? [...opts.extensions] : [];
		this.#extraEnv = opts.env;

		this.#cols = Math.max(1, opts.cols);
		this.#rows = Math.max(1, opts.rows);

		const XTerm = (xtermHeadless as any).default?.Terminal as (new (options: any) => Terminal) | undefined;
		if (!XTerm) {
			throw new Error("@xterm/headless Terminal export not found");
		}

		this.#term = new XTerm({
			allowProposedApi: true,
			cols: this.#cols,
			rows: this.#rows,
			convertEol: true,
			scrollback: 2000,
		});
	}

	start(appendSystemPrompt?: string): void {
		if (this.#pty) return;

		this.#lastError = null;
		this.#exited = null;
		this.#startedAt = Date.now();
		this.#hasOutput = false;

		const args: string[] = [
			...(this.#model ? ["--model", this.#model] : []),
			...(this.#thinking ? ["--thinking", this.#thinking] : []),
			...(this.#tools ? ["--tools", this.#tools] : []),
			...this.#extensions.flatMap(ext => ["--extension", ext]),
			...(appendSystemPrompt ? ["--append-system-prompt", appendSystemPrompt] : []),
			...this.#args,
		];

		const displayArgs: string[] = [
			...(this.#model ? ["--model", this.#model] : []),
			...(this.#thinking ? ["--thinking", this.#thinking] : []),
			...(this.#tools ? ["--tools", this.#tools] : []),
			...this.#extensions.flatMap(ext => ["--extension", ext]),
			...(appendSystemPrompt ? ["--append-system-prompt", "<append-system-prompt>"] : []),
			...this.#args,
		];

		this.#startCmd = [this.#ompCli, ...displayArgs];

		// Render a "starting" indicator immediately.
		this.#onDirty?.();

		const spawnCommand = this.#withParentDeathSignal(this.#ompCli, args);

		try {
			this.#pty = new PtyBridge({
				file: spawnCommand.file,
				args: spawnCommand.args,
				cwd: this.#cwd,
				cols: this.#cols,
				rows: this.#rows,
				env: {
					...process.env,
					TERM: "xterm-256color",
					COLORTERM: "truecolor",
					...(this.#extraEnv ?? {}),
				},
			});
		} catch (err) {
			this.#lastError = err instanceof Error ? err.message : String(err);
			this.#onDirty?.();
			return;
		}

		this.#pty.on("data", (chunk: string) => {
			this.#term.write(chunk, () => {
				if (!this.#hasOutput) {
					this.#hasOutput = this.#detectVisibleOutput();
				}
				this.#onDirty?.();
			});
		});

		this.#pty.on("exit", (e: any) => {
			this.#exited = e ?? {};
			this.#onDirty?.();
		});
	}

	#withParentDeathSignal(file: string, args: string[]): { file: string; args: string[] } {
		if (process.platform !== "linux") return { file, args };

		const setprivPath = Bun.which("setpriv");
		if (!setprivPath) {
			throw new Error(
				"setpriv is required on Linux to enforce PR_SET_PDEATHSIG/SIGKILL for singularity agent process",
			);
		}

		return {
			file: setprivPath,
			args: ["--pdeathsig", "KILL", "--", file, ...args],
		};
	}

	stop(): void {
		if (!this.#pty) return;
		try {
			this.#pty.kill();
		} catch (err) {
			logger.debug("tui/panes/singularity-pane.ts: best-effort failure after this.#pty.kill();", { err });
		}
		this.#pty = null;
	}

	resize(cols: number, rows: number): void {
		this.#cols = Math.max(1, cols);
		this.#rows = Math.max(1, rows);

		this.#term.resize(this.#cols, this.#rows);
		this.#pty?.resize(this.#cols, this.#rows);
	}

	handleKey(_name: string, data: any): boolean {
		const s = keyDataToString(data);
		if (!s) return false;

		this.#pty?.write(s);
		return true;
	}

	scrollLines(amount: number): void {
		if (amount === 0) return;
		try {
			this.#term.scrollLines(amount);
			this.#onDirty?.();
		} catch (err) {
			logger.debug("tui/panes/singularity-pane.ts: best-effort failure after this.#onDirty?.();", { err });
		}
	}

	handleMouse(name: string, _data: any, _region: Region): boolean {
		const dir = name === "MOUSE_WHEEL_UP" ? -1 : name === "MOUSE_WHEEL_DOWN" ? 1 : 0;
		if (!dir) return false;
		this.scrollLines(dir * 3);
		return true;
	}

	#detectVisibleOutput(): boolean {
		try {
			const buf = this.#term.buffer.active;
			const startY = buf.viewportY;
			const maxRows = Math.min(this.#rows, 6);

			for (let row = 0; row < maxRows; row += 1) {
				const line = buf.getLine(startY + row);
				const text = line ? line.translateToString(true) : "";
				if (text.trim().length > 0) return true;
			}

			return false;
		} catch {
			return true; // assume visible to avoid getting stuck in "starting" state
		}
	}

	#getTailPlainLines(maxLines: number): string[] {
		if (maxLines <= 0) return [];

		try {
			const buf = this.#term.buffer.active;
			const lastAbsY = Math.max(0, buf.baseY + this.#rows - 1);
			const startAbsY = Math.max(0, lastAbsY - maxLines + 1);

			const out: string[] = [];
			for (let y = startAbsY; y <= lastAbsY; y += 1) {
				const line = buf.getLine(y);
				const text = line ? line.translateToString(true).replace(/\s+$/g, "") : "";
				out.push(text);
			}

			while (out.length > 0 && out[0] && out[0].trim().length === 0) {
				out.shift();
			}

			return out.slice(-maxLines);
		} catch {
			return [];
		}
	}

	render(term: TerminalLike, region: Region): void {
		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);
		if (width <= 0 || height <= 0) return;

		const clearRows = (startRow: number) => {
			for (let row = startRow; row < height; row += 1) {
				term.moveTo(region.x, region.y + row);
				term(" ".repeat(width));
			}
		};

		if (this.#lastError) {
			term.moveTo(region.x, region.y);
			term(clipPad(`Singularity error: ${this.#lastError}`, width));
			clearRows(1);
			return;
		}

		if (this.#exited) {
			const code = typeof this.#exited.exitCode === "number" ? String(this.#exited.exitCode) : "?";
			const signal = typeof this.#exited.signal === "number" ? String(this.#exited.signal) : null;
			term.moveTo(region.x, region.y);
			term(
				clipPad(
					signal ? `Singularity exited (code ${code}, signal ${signal})` : `Singularity exited (code ${code})`,
					width,
				),
			);

			const tailRows = Math.max(0, height - 1);
			const tailLines = this.#getTailPlainLines(tailRows);
			for (let row = 0; row < tailRows; row += 1) {
				term.moveTo(region.x, region.y + 1 + row);
				term(clipPad(tailLines[row] ?? "", width));
			}
			return;
		}

		if (!this.#hasOutput) {
			const cmd = this.#startCmd ? formatCmd(this.#startCmd) : this.#ompCli;
			const elapsed = this.#startedAt ? Math.max(0, Date.now() - this.#startedAt) : 0;

			const line1 = `Starting: ${cmd}`;
			const line2 = `Waiting for omp output… (${Math.round(elapsed / 1000)}s)`;

			term.moveTo(region.x, region.y);
			term(clipPad(line1, width));
			if (height >= 2) {
				term.moveTo(region.x, region.y + 1);
				term(clipPad(line2, width));
			}
			clearRows(height >= 2 ? 2 : 1);
			return;
		}

		const buf = this.#term.buffer.active;
		const startY = buf.viewportY;
		const nullCell = buf.getNullCell();

		for (let row = 0; row < height; row += 1) {
			const y = startY + row;
			const line = buf.getLine(y);

			term.moveTo(region.x, region.y + row);
			term(renderBufferLineAnsi(line, nullCell, width));
		}

		// Render a visible cursor overlay (terminal-kit cursor is hidden while OMS runs).
		try {
			const cursorAbsY = buf.baseY + buf.cursorY;
			const cursorRow = cursorAbsY - startY;
			let cursorCol = buf.cursorX;

			if (cursorRow >= 0 && cursorRow < height) {
				if (cursorCol < 0) cursorCol = 0;
				if (cursorCol >= width) cursorCol = Math.max(0, width - 1);

				const cursorLine = buf.getLine(cursorAbsY);
				const cell = cursorLine?.getCell ? cursorLine.getCell(cursorCol, nullCell) : null;
				let ch = cell && typeof cell.getChars === "function" ? cell.getChars() : "";
				if (!ch) ch = " ";

				term.moveTo(region.x + cursorCol, region.y + cursorRow);
				term(`\x1b[7m${ch[0] ?? " "}\x1b[0m`);
			}
		} catch (err) {
			logger.debug("tui/panes/singularity-pane.ts: best-effort failure rendering cursor highlight", { err });
		}
	}
}

function formatCmd(cmd: readonly string[]): string {
	return cmd
		.map(part => {
			if (part === "") return '""';
			if (/[^A-Za-z0-9_\-./:=@]/.test(part)) return JSON.stringify(part);
			return part;
		})
		.join(" ");
}

function renderBufferLineAnsi(line: any | undefined, nullCell: any, width: number): string {
	// Render xterm buffer cells into ANSI SGR sequences (colors/styles) + chars.
	// Always emit exactly `width` columns worth of characters.

	let out = "\x1b[0m";
	let prevKey = "d";

	const defaultCell = null;

	for (let x = 0; x < width; ) {
		const cell = line?.getCell ? line.getCell(x, nullCell) : defaultCell;

		if (!cell) {
			if (prevKey !== "d") {
				out += "\x1b[0m";
				prevKey = "d";
			}
			out += " ";
			x += 1;
			continue;
		}

		const w = typeof cell.getWidth === "function" ? cell.getWidth() : 1;
		if (w <= 0) {
			x += 1;
			continue;
		}

		if (x + w > width) {
			// Wide char clipped by viewport width.
			if (prevKey !== "d") {
				out += "\x1b[0m";
				prevKey = "d";
			}
			out += " ";
			x += 1;
			continue;
		}

		const key = styleKey(cell);
		if (key !== prevKey) {
			out += sgrForCell(cell);
			prevKey = key;
		}

		let chars = typeof cell.getChars === "function" ? cell.getChars() : "";
		if (!chars) {
			chars = w > 1 ? " ".repeat(w) : " ";
		}

		if (typeof cell.isInvisible === "function" && cell.isInvisible()) {
			chars = " ".repeat(w);
		}

		out += chars;
		x += w;
	}

	out += "\x1b[0m";
	return out;
}

function styleKey(cell: any): string {
	if (!cell) return "d";
	if (typeof cell.isAttributeDefault === "function" && cell.isAttributeDefault()) return "d";

	const fgMode = typeof cell.getFgColorMode === "function" ? cell.getFgColorMode() : 0;
	const bgMode = typeof cell.getBgColorMode === "function" ? cell.getBgColorMode() : 0;
	const fg = typeof cell.getFgColor === "function" ? cell.getFgColor() : 0;
	const bg = typeof cell.getBgColor === "function" ? cell.getBgColor() : 0;

	const flags = [
		typeof cell.isBold === "function" && cell.isBold() ? 1 : 0,
		typeof cell.isDim === "function" && cell.isDim() ? 1 : 0,
		typeof cell.isItalic === "function" && cell.isItalic() ? 1 : 0,
		typeof cell.isUnderline === "function" && cell.isUnderline() ? 1 : 0,
		typeof cell.isInverse === "function" && cell.isInverse() ? 1 : 0,
		typeof cell.isStrikethrough === "function" && cell.isStrikethrough() ? 1 : 0,
		typeof cell.isOverline === "function" && cell.isOverline() ? 1 : 0,
	].join("");

	return `${fgMode}:${fg}:${bgMode}:${bg}:${flags}`;
}

function sgrForCell(cell: any): string {
	if (!cell) return "\x1b[0m";
	if (typeof cell.isAttributeDefault === "function" && cell.isAttributeDefault()) return "\x1b[0m";

	const codes: string[] = ["0"]; // start with reset

	if (typeof cell.isBold === "function" && cell.isBold()) codes.push("1");
	if (typeof cell.isDim === "function" && cell.isDim()) codes.push("2");
	if (typeof cell.isItalic === "function" && cell.isItalic()) codes.push("3");
	if (typeof cell.isUnderline === "function" && cell.isUnderline()) codes.push("4");
	if (typeof cell.isBlink === "function" && cell.isBlink()) codes.push("5");
	if (typeof cell.isInverse === "function" && cell.isInverse()) codes.push("7");
	if (typeof cell.isStrikethrough === "function" && cell.isStrikethrough()) codes.push("9");
	if (typeof cell.isOverline === "function" && cell.isOverline()) codes.push("53");

	// Foreground
	if (typeof cell.isFgRGB === "function" && cell.isFgRGB()) {
		const c = typeof cell.getFgColor === "function" ? cell.getFgColor() : 0;
		const r = (c >> 16) & 0xff;
		const g = (c >> 8) & 0xff;
		const b = c & 0xff;
		codes.push(`38;2;${r};${g};${b}`);
	} else if (typeof cell.isFgPalette === "function" && cell.isFgPalette()) {
		const n = typeof cell.getFgColor === "function" ? cell.getFgColor() : 0;
		codes.push(`38;5;${n}`);
	}

	// Background
	if (typeof cell.isBgRGB === "function" && cell.isBgRGB()) {
		const c = typeof cell.getBgColor === "function" ? cell.getBgColor() : 0;
		const r = (c >> 16) & 0xff;
		const g = (c >> 8) & 0xff;
		const b = c & 0xff;
		codes.push(`48;2;${r};${g};${b}`);
	} else if (typeof cell.isBgPalette === "function" && cell.isBgPalette()) {
		const n = typeof cell.getBgColor === "function" ? cell.getBgColor() : 0;
		codes.push(`48;5;${n}`);
	}

	return `\x1b[${codes.join(";")}m`;
}
