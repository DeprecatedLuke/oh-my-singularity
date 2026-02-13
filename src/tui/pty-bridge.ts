import { EventEmitter } from "node:events";
import type { IDisposable, IExitEvent, IPty } from "bun-pty";
import { spawn } from "bun-pty";
import { logger } from "../utils";

export interface PtyBridgeOptions {
	file: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	cols: number;
	rows: number;
	name?: string;
}

export class PtyBridge extends EventEmitter {
	readonly #ptyProcess: IPty;
	readonly #disposables: IDisposable[] = [];
	#exited = false;

	constructor(opts: PtyBridgeOptions) {
		super();

		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(opts.env ?? process.env)) {
			if (typeof v === "string") env[k] = v;
		}

		this.#ptyProcess = spawn(opts.file, opts.args, {
			name: opts.name ?? "xterm-256color",
			cwd: opts.cwd,
			env,
			cols: Math.max(1, opts.cols),
			rows: Math.max(1, opts.rows),
		});

		this.#disposables.push(
			this.#ptyProcess.onData(data => {
				this.emit("data", data);
			}),
		);

		this.#disposables.push(
			this.#ptyProcess.onExit((e: IExitEvent) => {
				if (this.#exited) return;
				this.#exited = true;
				this.emit("exit", e);
				this.#dispose();
			}),
		);
	}

	#dispose(): void {
		for (const d of this.#disposables.splice(0)) {
			try {
				d.dispose();
			} catch (err) {
				logger.debug("tui/pty-bridge.ts: best-effort failure after d.dispose();", { err });
			}
		}
	}

	resize(cols: number, rows: number): void {
		this.#ptyProcess.resize(Math.max(1, cols), Math.max(1, rows));
	}

	write(data: string | Buffer): void {
		this.#ptyProcess.write(typeof data === "string" ? data : data.toString("utf8"));
	}

	kill(signal?: string): void {
		if (this.#exited) return;
		try {
			this.#ptyProcess.kill(signal);
		} finally {
			this.#dispose();
		}
	}
}
