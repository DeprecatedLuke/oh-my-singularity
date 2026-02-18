import net from "node:net";
import { logger } from "../../utils";

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
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				return {
					content: [
						{
							type: "text",
							text: "OMS broadcast socket not configured (OMS_SINGULARITY_SOCK is empty).",
						},
					],
				};
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
				await sendLine(sockPath, payload);
				return {
					content: [{ type: "text", text: "OK (broadcast queued)" }],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to broadcast: ${message}`,
						},
					],
					details: { sockPath, error: message },
				};
			}
		},
	});
}

function sendLine(sockPath: string, line: string, timeoutMs = 1500): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;

		const client = net.createConnection({ path: sockPath }, () => {
			client.write(`${line}\n`);
			client.end();
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
			resolve();
		});
	});
}
