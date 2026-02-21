import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "./types";

const REGISTRATION_SENTINEL = "__oms_omp_crash_logger_registered__";
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGSEGV", "SIGABRT"];

function formatTimestampForFilename(ts: number): string {
	return new Date(ts).toISOString().replace(/[:.]/g, "-");
}

function sanitizeToken(value: string | undefined, fallback: string): string {
	const normalized = typeof value === "string" ? value.trim() : "";
	if (!normalized) return fallback;

	const sanitized = normalized
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || fallback;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function normalizeError(value: unknown): { name: string; message: string; stack: string } {
	if (value instanceof Error) {
		return {
			name: value.name || "Error",
			message: value.message || String(value),
			stack: typeof value.stack === "string" ? value.stack : "",
		};
	}

	const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
	const name = typeof rec?.name === "string" && rec.name.trim() ? rec.name.trim() : "Error";
	const message =
		typeof rec?.message === "string" && rec.message.trim()
			? rec.message.trim()
			: typeof value === "string"
				? value
				: safeJsonStringify(value);
	const stack = typeof rec?.stack === "string" ? rec.stack : "";

	return { name, message, stack };
}

function formatSection(name: string, value: unknown): string {
	return `${name}:\n${safeJsonStringify(value)}`;
}

function getCrashesDir(): string | null {
	const taskStoreDir = process.env.OMS_TASK_STORE_DIR;
	if (typeof taskStoreDir !== "string" || !taskStoreDir.trim()) return null;
	const sessionDir = path.dirname(path.resolve(taskStoreDir));
	return path.join(sessionDir, "crashes");
}

function writeUniqueCrashFile(basePath: string, payload: string): void {
	const parsed = path.parse(basePath);
	const baseStem = path.join(parsed.dir, parsed.name);
	const ext = parsed.ext || ".log";

	for (let index = 0; index < 100; index += 1) {
		const candidate = index === 0 ? `${baseStem}${ext}` : `${baseStem}-${index}${ext}`;
		try {
			fs.writeFileSync(candidate, payload, { encoding: "utf8", flag: "wx" });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EEXIST") continue;
			return;
		}
	}
}

function scheduleFatalExit(): void {
	process.exitCode = 1;
	setImmediate(() => {
		process.exit(1);
	});
}

export default async function ompCrashLoggerExtension(_api: ExtensionAPI): Promise<void> {
	const globalState = globalThis as Record<string, unknown>;
	if (globalState[REGISTRATION_SENTINEL]) return;
	globalState[REGISTRATION_SENTINEL] = true;

	let didWriteCrashLog = false;
	const writeCrashLog = (context: string, error: unknown, extra?: unknown): void => {
		if (didWriteCrashLog) return;
		didWriteCrashLog = true;

		try {
			const crashesDir = getCrashesDir();
			if (!crashesDir) return;

			const ts = Date.now();
			const isoTs = new Date(ts).toISOString();
			const agentType = sanitizeToken(process.env.OMS_AGENT_TYPE, "unknown-agent");
			const agentId = sanitizeToken(process.env.OMS_AGENT_ID, "unknown-agent");
			const fileName = `omp-crash-${formatTimestampForFilename(ts)}-${agentId}-${agentType}.log`;
			const filePath = path.join(crashesDir, fileName);

			const normalizedError = normalizeError(error);
			const lines: string[] = [];
			lines.push("OMP Crash Log");
			lines.push("");
			lines.push(`timestamp: ${isoTs}`);
			lines.push(`context: ${context}`);
			lines.push(`pid: ${process.pid}`);
			lines.push(`ppid: ${process.ppid}`);
			lines.push(`cwd: ${process.cwd()}`);
			lines.push(`uptimeSeconds: ${process.uptime().toFixed(3)}`);
			lines.push("");
			lines.push("error:");
			lines.push(`name: ${normalizedError.name}`);
			lines.push(`message: ${normalizedError.message}`);
			if (normalizedError.stack.trim()) {
				lines.push("stack:");
				lines.push(normalizedError.stack);
			}
			lines.push("");
			lines.push(
				formatSection("agent", {
					agentType: process.env.OMS_AGENT_TYPE ?? null,
					taskId: process.env.OMS_TASK_ID ?? null,
					agentId: process.env.OMS_AGENT_ID ?? null,
					tasksActor: process.env.TASKS_ACTOR ?? null,
				}),
			);
			lines.push("");
			lines.push(
				formatSection("process", {
					argv: process.argv,
					execPath: process.execPath,
					bunVersion: process.versions.bun,
					nodeVersion: process.versions.node,
				}),
			);
			if (extra !== undefined) {
				lines.push("");
				lines.push(formatSection("extra", extra));
			}

			const payload = `${lines.join("\n").trimEnd()}\n`;
			fs.mkdirSync(crashesDir, { recursive: true });
			writeUniqueCrashFile(filePath, payload);
		} catch {
			// best-effort: crash logger must never throw
		}
	};

	process.on("uncaughtException", error => {
		writeCrashLog("uncaughtException", error);
		scheduleFatalExit();
	});

	process.on("unhandledRejection", (reason, promise) => {
		writeCrashLog("unhandledRejection", reason, {
			reasonType: typeof reason,
			promise,
		});
		scheduleFatalExit();
	});

	for (const signal of SIGNALS) {
		try {
			const handler = () => {
				writeCrashLog(`signal:${signal}`, new Error(`Process received ${signal}`), { signal });
				try {
					process.removeListener(signal, handler);
					process.kill(process.pid, signal);
					return;
				} catch {
					scheduleFatalExit();
				}
			};
			process.on(signal, handler);
		} catch {
			// signal may not be supported by the runtime/platform
		}
	}
}
