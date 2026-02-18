import net from "node:net";
import { logger } from "../../utils";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides a `broadcast_to_workers` tool that asks the outer OMS process to
 * evaluate whether a message applies to any running workers.
 *
 * OMS will spawn a steering agent to decide whether to:
 * - steer (notify) running workers
 * - interrupt (abort) running workers
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function broadcastToWorkersExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "broadcast_to_workers",
		label: "Broadcast to Workers",
		description:
			"Broadcast a coordination message to running workers. OMS will decide who to notify or interrupt. Use when your changes affect ALL running workers simultaneously (shared module changes, type/interface changes, build config changes, global convention changes). Keep messages specific: what changed, files touched, what workers should watch. Never use for single-task corrections.",
		parameters: Type.Object(
			{
				message: Type.String({ description: "Message to broadcast" }),
				urgency: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("critical")])),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const message = typeof args?.message === "string" ? args.message.trim() : "";
			const urgency = typeof args?.urgency === "string" ? args.urgency : "normal";
			const details = [message ? `message=${message}` : "", `urgency=${urgency}`];
			return renderToolCall("Broadcast to Workers", details.filter(Boolean), theme, options);
		},
		renderResult: (result, options, theme) => renderToolResult("Broadcast to Workers", result, options, theme),
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS broadcast socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const role = process.env.OMS_ROLE ?? "agent";
			const taskId = process.env.OMS_TASK_ID ?? null;

			const payload = JSON.stringify({
				type: "broadcast",
				message: typeof params?.message === "string" ? params.message : "",
				urgency: typeof params?.urgency === "string" ? params.urgency : "normal",
				from: {
					role,
					taskId,
				},
				ts: Date.now(),
			});

			try {
				const response = await sendLine(sockPath, payload);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: "broadcast_to_workers failed";
					throw new Error(error);
				}
				return {
					content: [{ type: "text", text: "OK (broadcast queued)" }],
				};
			} catch (err) {
				throw new Error(`Failed to broadcast: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

function sendLine(sockPath: string, line: string, timeoutMs = 1500): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let settled = false;
	let responseText = "";
	const client = net.createConnection({ path: sockPath }, () => {
		client.write(`${line}\n`);
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
			logger.debug("agents/extensions/broadcast-to-workers.ts: best-effort failure after client.destroy();", {
				err,
			});
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
			resolve(JSON.parse(trimmed));
		} catch {
			resolve(trimmed);
		}
	});
	return promise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
