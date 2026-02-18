import type { FileSink } from "bun";
import { logger } from "../utils";

export type OmsRpcEventListener = (event: unknown) => void;

export interface OmsRpcClientOptions {
	/** CLI to run; defaults to `omp`. */
	ompCli?: string;

	/** Working directory for the spawned process. */
	cwd?: string;

	/** Extra env vars for the spawned process. */
	env?: Record<string, string>;

	/** Additional args appended after `--mode rpc`. */
	args?: string[];

	/** Per-request timeout (ms). Defaults to 30s. */
	requestTimeoutMs?: number;

	/** Max stderr buffer size (chars). Defaults to 50k. */
	maxStderrChars?: number;
}

type RpcResponse = {
	type: "response";
	command?: string;
	success: boolean;
	id?: string;
	data?: unknown;
	error?: string;
	[key: string]: unknown;
};

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timeout: Timer;
	commandType: string;
};

function extractSessionId(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;

	const rec = value as Record<string, unknown>;
	const candidates = [rec.session_id, rec.sessionId];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed) return trimmed;
	}

	return null;
}

export class OmsRpcClient {
	private readonly opts: Required<Pick<OmsRpcClientOptions, "ompCli" | "requestTimeoutMs" | "maxStderrChars">> &
		OmsRpcClientOptions;

	private proc: Bun.PipedSubprocess | null = null;
	private stdin: FileSink | null = null;

	private readonly listeners = new Set<OmsRpcEventListener>();
	private readonly pending = new Map<string, PendingRequest>();

	private reqSeq = 0;
	private stdoutTask: Promise<void> | null = null;
	private stderrTask: Promise<void> | null = null;
	private exitTask: Promise<void> | null = null;

	private stderrBuf = "";
	private sessionId: string | null = null;
	#suppressAgentEndCount = 0;

	constructor(opts?: OmsRpcClientOptions) {
		this.opts = {
			ompCli: opts?.ompCli ?? "omp",
			requestTimeoutMs: opts?.requestTimeoutMs ?? 30_000,
			maxStderrChars: opts?.maxStderrChars ?? 50_000,
			...opts,
		};
	}

	start(): void {
		if (this.proc) {
			throw new Error("OmsRpcClient already started");
		}

		const cmd = [this.opts.ompCli, "--mode", "rpc", ...(this.opts.args ?? [])];

		// Bun expects env as a record of strings; do not implicitly inherit process.env
		// unless the caller passed it (Bun does inherit by default).
		const proc = Bun.spawn({
			cmd,
			cwd: this.opts.cwd,
			env: this.opts.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		}) as Bun.PipedSubprocess;

		this.proc = proc;
		this.stdin = proc.stdin;
		this.stdoutTask = this.readStdoutLoop(proc);
		this.stderrTask = this.readStderrLoop(proc);
		this.exitTask = this.watchExit(proc);
	}

	async stop(_opts?: { timeoutMs?: number }): Promise<void> {
		if (!this.proc) return;

		const proc = this.proc;
		this.proc = null;

		try {
			proc.kill();
		} catch (err) {
			logger.debug("agents/rpc-wrapper.ts: best-effort failure after proc.kill();", { err });
		}

		try {
			await proc.exited;
		} catch (err) {
			logger.debug("agents/rpc-wrapper.ts: best-effort failure after await proc.exited;", { err });
		}

		try {
			if (this.stdin) {
				try {
					await this.stdin.end();
				} catch (err) {
					logger.debug("agents/rpc-wrapper.ts: best-effort failure after await this.stdin.end();", { err });
				}
			}
		} finally {
			this.stdin = null;
		}

		const backgroundTasks = [this.stdoutTask, this.stderrTask, this.exitTask].filter(
			(task): task is Promise<void> => task !== null,
		);
		this.stdoutTask = null;
		this.stderrTask = null;
		this.exitTask = null;

		if (backgroundTasks.length > 0) await Promise.allSettled(backgroundTasks);

		this.rejectAllPending(new Error(this.formatErr("RPC process stopped")));
	}

	onEvent(listener: OmsRpcEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getStderr(): string {
		return this.stderrBuf;
	}

	getSessionId(): string | null {
		return this.sessionId;
	}

	async refreshSessionId(): Promise<string | null> {
		try {
			const data = await this.send({ type: "get_session_id" });
			const direct = extractSessionId(data);
			if (direct) {
				this.sessionId = direct;
				return direct;
			}
			if (typeof data === "string") {
				const trimmed = data.trim();
				if (trimmed) {
					this.sessionId = trimmed;
					return trimmed;
				}
			}
		} catch (err) {
			logger.debug(
				"agents/rpc-wrapper.ts: failed to extract session ID from last result; falling back to getState()",
				{ err },
			);
		}

		try {
			const state = await this.getState();
			const fromState = extractSessionId(state);
			if (fromState) {
				this.sessionId = fromState;
				return fromState;
			}
		} catch (err) {
			logger.debug("agents/rpc-wrapper.ts: best-effort failure after return fromState;", { err });
		}

		return this.sessionId;
	}

	forceKill(): void {
		if (!this.proc) return;

		const proc = this.proc;
		this.proc = null;
		this.stdin = null;
		this.stdoutTask = null;
		this.stderrTask = null;
		this.exitTask = null;

		try {
			proc.kill();
		} catch (err) {
			logger.debug("agents/rpc-wrapper.ts: best-effort failure after proc.kill();", { err });
		}

		this.rejectAllPending(new Error(this.formatErr("RPC process force-killed")));
	}
	suppressNextAgentEnd(): void {
		this.#suppressAgentEndCount += 1;
	}

	waitForAgentEnd(timeoutMs = 300_000): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let timer: Timer | null = null;
			const unsubscribe = this.onEvent(event => {
				if (settled) return;
				const rec =
					event && typeof event === "object" && !Array.isArray(event) ? (event as { type?: unknown }) : null;
				if (rec?.type === "agent_end") {
					settled = true;
					if (timer) clearTimeout(timer);
					unsubscribe();
					resolve();
				} else if (rec?.type === "rpc_exit") {
					settled = true;
					if (timer) clearTimeout(timer);
					unsubscribe();
					reject(new Error(this.formatErr("RPC process exited before agent_end")));
				}
			});

			timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				unsubscribe();
				reject(new Error(this.formatErr(`Timeout waiting for agent_end after ${timeoutMs}ms`)));
			}, timeoutMs);
		});
	}

	async prompt(message: string): Promise<void> {
		await this.send({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.send({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.send({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async abortAndPrompt(message: string): Promise<void> {
		await this.send({ type: "abort_and_prompt", message });
	}

	async getState(): Promise<unknown> {
		return await this.send({ type: "get_state" });
	}

	async setThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	async getLastAssistantText(): Promise<string | null> {
		const data = await this.send({ type: "get_last_assistant_text" });

		if (data === null) return null;
		if (typeof data === "string") return data;

		if (data && typeof data === "object") {
			const maybeText = (data as { text?: unknown }).text;
			if (typeof maybeText === "string") return maybeText;
		}

		return null;
	}

	async getMessages(): Promise<unknown[]> {
		const data = await this.send({ type: "get_messages" });
		return Array.isArray(data) ? (data as unknown[]) : [];
	}

	async send<T = unknown>(command: Record<string, unknown>): Promise<T> {
		const proc = this.proc;
		const stdin = this.stdin;
		if (!proc || !stdin) {
			throw new Error(this.formatErr("RPC process not started (call start() before send/prompt/etc)"));
		}

		const id = `req_${++this.reqSeq}`;
		const commandType = typeof command.type === "string" ? command.type : "";
		const payload = { ...command, id };

		const line = `${JSON.stringify(payload)}\n`;

		const resultPromise = new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						this.formatErr(
							`RPC request timed out after ${this.opts.requestTimeoutMs}ms: ${commandType || "(unknown)"} (${id})`,
						),
					),
				);
			}, this.opts.requestTimeoutMs);

			this.pending.set(id, {
				resolve,
				reject,
				timeout,
				commandType: commandType || "(unknown)",
			});
		});

		// Write after registering pending to avoid race with very fast responses.
		try {
			await stdin.write(line);
		} catch (err) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pending.delete(id);
			}

			throw new Error(
				this.formatErr(`Failed to write RPC command ${commandType || "(unknown)"} (${id}): ${String(err)}`),
			);
		}

		return (await resultPromise) as T;
	}

	private async readStdoutLoop(proc: Bun.PipedSubprocess): Promise<void> {
		const decoder = new TextDecoder();
		const reader = proc.stdout.getReader();

		let buf = "";

		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;

				buf += decoder.decode(value, { stream: true });

				while (true) {
					const nl = buf.indexOf("\n");
					if (nl < 0) break;

					const rawLine = buf.slice(0, nl);
					buf = buf.slice(nl + 1);

					const line = rawLine.trim();
					if (!line) continue;

					let obj: unknown;
					try {
						obj = JSON.parse(line);
					} catch (err) {
						this.emitEvent({
							type: "rpc_parse_error",
							line,
							error: String(err),
						});
						continue;
					}

					if (obj && typeof obj === "object" && (obj as { type?: unknown }).type === "response") {
						this.handleResponse(obj as RpcResponse);
					} else {
						this.emitEvent(obj);
					}
				}
			}
		} finally {
			try {
				reader.releaseLock();
			} catch (err) {
				logger.debug("agents/rpc-wrapper.ts: best-effort failure after reader.releaseLock();", { err });
			}
		}
	}

	private async readStderrLoop(proc: Bun.PipedSubprocess): Promise<void> {
		const decoder = new TextDecoder();
		const reader = proc.stderr.getReader();

		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;

				this.appendStderr(decoder.decode(value, { stream: true }));
			}
		} finally {
			try {
				reader.releaseLock();
			} catch (err) {
				logger.debug("agents/rpc-wrapper.ts: best-effort failure after reader.releaseLock();", { err });
			}
		}
	}

	private async watchExit(proc: Bun.PipedSubprocess): Promise<void> {
		try {
			const exitCode = await proc.exited;
			this.emitEvent({ type: "rpc_exit", exitCode });
			this.rejectAllPending(new Error(this.formatErr(`RPC process exited: ${exitCode}`)));
		} catch (err) {
			this.emitEvent({ type: "rpc_exit", error: String(err) });
			this.rejectAllPending(new Error(this.formatErr(`RPC process exited with error: ${String(err)}`)));
		}
	}

	private handleResponse(resp: RpcResponse): void {
		const id = resp.id;
		if (!id) {
			this.emitEvent(resp);
			return;
		}

		const pending = this.pending.get(id);
		if (!pending) {
			// Unknown response id: forward as event.
			this.emitEvent(resp);
			return;
		}

		clearTimeout(pending.timeout);
		this.pending.delete(id);

		if (resp.success) {
			const sessionId = extractSessionId(resp.data);
			if (sessionId) this.sessionId = sessionId;
			pending.resolve(resp.data);
			return;
		}

		const errMsg = resp.error ?? `RPC command failed: ${pending.commandType} (${id})`;
		pending.reject(new Error(this.formatErr(errMsg)));
	}

	private emitEvent(event: unknown): void {
		const sessionId = extractSessionId(event);
		if (sessionId) this.sessionId = sessionId;
		const rec = event && typeof event === "object" && !Array.isArray(event) ? (event as { type?: unknown }) : null;
		if (rec?.type === "agent_end" && this.#suppressAgentEndCount > 0) {
			this.#suppressAgentEndCount -= 1;
			return;
		}
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// Listener errors must not break the reader loop.
			}
		}
	}

	private appendStderr(chunk: string): void {
		if (!chunk) return;

		this.stderrBuf += chunk;
		const max = this.opts.maxStderrChars;
		if (this.stderrBuf.length > max) {
			this.stderrBuf = this.stderrBuf.slice(this.stderrBuf.length - max);
		}
	}

	private rejectAllPending(err: Error): void {
		for (const [id, pending] of this.pending.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error(this.formatErr(`${err.message} (while waiting for ${pending.commandType} ${id})`)));
		}
		this.pending.clear();
	}

	private formatErr(message: string): string {
		const stderr = this.getStderr().trim();
		if (!stderr) return message;
		return `${message}\n\n--- omp stderr (tail) ---\n${stderr}`;
	}
}
