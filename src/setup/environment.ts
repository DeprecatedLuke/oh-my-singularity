import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OmsConfigOverride } from "../config";
import { PATH_MAX_SOCK_PATH_LENGTH } from "../config/constants";

export function ensureDirExists(dir: string): void {
	if (!fs.existsSync(dir)) {
		throw new Error(`Target project path does not exist: ${dir}`);
	}

	const stat = fs.statSync(dir);
	if (!stat.isDirectory()) {
		throw new Error(`Target project path is not a directory: ${dir}`);
	}
}

export function ensureGlobalOmsConfigDir(): {
	omsDir: string;
	configPath: string;
} {
	const omsDir = path.join(os.homedir(), ".oms");
	const configPath = path.join(omsDir, "config.json");

	// Ensure directory exists so users can easily drop a global config file.
	fs.mkdirSync(omsDir, { recursive: true });

	return { omsDir, configPath };
}

export function computeOmsSessionDirName(cwd: string, maxLen: number): string {
	const inner = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const base = `--${inner}--`;
	if (base.length <= maxLen) return base;

	const hash = crypto.createHash("sha1").update(cwd).digest("hex").slice(0, 10);
	const suffix = `-${hash}--`;
	const keep = Math.max(0, maxLen - suffix.length);
	const clipped = base.slice(0, Math.max(2, keep));
	const name = `${clipped}${suffix}`;
	if (name.length <= maxLen) return name;

	// Hard fallback.
	return `--${hash}--`;
}

export function computeOmsSingularitySockPath(targetCwd: string): {
	sessionDir: string;
	sockPath: string;
} {
	const sessionsBase = path.join(os.homedir(), ".oms", "sessions");
	fs.mkdirSync(sessionsBase, { recursive: true });

	// Unix domain socket paths have a small max length (sun_path ~108 bytes on Linux).
	// Keep headroom to avoid ENAMETOOLONG.
	const sockFile = "singularity.sock";
	const maxSockPathLen = PATH_MAX_SOCK_PATH_LENGTH;
	const overhead = sessionsBase.length + 1 /* / */ + 1 /* / */ + sockFile.length;
	const maxDirNameLen = Math.max(16, maxSockPathLen - overhead);

	const sessionDirName = computeOmsSessionDirName(targetCwd, maxDirNameLen);
	const sessionDir = path.join(sessionsBase, sessionDirName);
	fs.mkdirSync(sessionDir, { recursive: true });

	return {
		sessionDir,
		sockPath: path.join(sessionDir, sockFile),
	};
}

export function loadOmsConfigOverride(configPath: string): OmsConfigOverride | null {
	if (!fs.existsSync(configPath)) return null;
	const raw = fs.readFileSync(configPath, "utf8");
	if (!raw.trim()) return null;
	try {
		return JSON.parse(raw) as OmsConfigOverride;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse OMS config override: ${configPath}\n${msg}`);
	}
}

export function resolveOmpPath(ompCli: string): string {
	const ompResolved = Bun.which(ompCli);
	if (!ompResolved) {
		if (path.isAbsolute(ompCli)) {
			if (!fs.existsSync(ompCli)) {
				throw new Error(`omp CLI not found at: ${ompCli}`);
			}
		} else {
			throw new Error(`omp CLI not found in PATH: ${ompCli}`);
		}
	}
	return ompResolved ?? ompCli;
}

export function buildEnv(extra: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries({ ...process.env, ...extra })) {
		if (typeof v === "string") env[k] = v;
	}
	return env;
}
