import net from "node:net";
import { logger } from "../../utils";
import type { UnknownRecord } from "./types";

/**
 * Send a JSON payload to the OMS singularity IPC socket and return the parsed response.
 *
 * Handles connection, serialization, timeout, and response parsing in one place.
 * All extension tools should use this instead of rolling their own socket boilerplate.
 */
export function sendIpc(sockPath: string, payload: unknown, timeoutMs = 1_500): Promise<UnknownRecord> {
	const { promise, resolve, reject } = Promise.withResolvers<UnknownRecord>();
	let settled = false;
	let responseText = "";

	const client = net.createConnection({ path: sockPath }, () => {
		client.write(`${JSON.stringify(payload)}\n`);
		client.end();
	});

	client.setEncoding("utf8");
	client.on("data", chunk => {
		responseText += chunk;
	});

	const timeout = setTimeout(() => {
		if (settled) return;
		settled = true;
		try {
			client.destroy();
		} catch (err) {
			logger.debug("ipc-client: best-effort client.destroy() failed", { err });
		}
		reject(new Error(`Timeout connecting to ${sockPath}`));
	}, timeoutMs);

	client.on("error", err => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		reject(err);
	});

	client.on("close", () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);

		const trimmed = responseText.trim();
		if (!trimmed || trimmed === "ok") {
			resolve({ ok: true });
			return;
		}

		try {
			const parsed = JSON.parse(trimmed);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				resolve({ ok: true, data: parsed });
				return;
			}
			resolve(parsed as UnknownRecord);
		} catch {
			resolve({ ok: true, text: trimmed });
		}
	});

	return promise;
}

/**
 * Resolve the OMS singularity socket path or throw.
 */
export function requireSockPath(): string {
	const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
	if (!sockPath.trim()) {
		throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
	}
	return sockPath;
}

/**
 * Extract a human-readable error string from an IPC response, or return null if ok.
 */
export function ipcError(response: UnknownRecord, fallback: string): string | null {
	if (response.ok !== false) return null;
	if (typeof response.error === "string" && response.error.trim()) return response.error.trim();
	if (typeof response.summary === "string" && response.summary.trim()) return response.summary.trim();
	return fallback;
}
