import net from "node:net";
import { logger } from "../../utils";

import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides a `start_tasks` tool that signals the outer OMS process
 * via a unix domain socket.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function omsStartTasksExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "start_tasks",
		label: "Start Tasks",
		description:
			"Trigger OMS to check for ready tasks and start issuers immediately. Use this after creating new tasks or unblocking existing tasks to begin the issuer→worker pipeline.",
		parameters: Type.Object(
			{
				count: Type.Optional(
					Type.Number({
						description: "Optional maximum number of tasks to start",
						minimum: 0,
					}),
				),
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
							text: "OMS start-tasks socket not configured (OMS_SINGULARITY_SOCK is empty).",
						},
					],
				};
			}
			const count = typeof params?.count === "number" ? params.count : undefined;
			try {
				await startTasksWithCount(sockPath, count);
				return {
					content: [{ type: "text", text: "OK (started OMS task spawning)" }],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to send start_tasks to OMS: ${message}`,
						},
					],
					details: { sockPath, error: message },
				};
			}
		},
	});

	api.registerCommand?.("start", {
		description: "Trigger OMS to check for ready tasks and start issuers immediately.",
		handler: async (_context: unknown) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS start-tasks socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			try {
				await startTasksWithCount(sockPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to send start_tasks to OMS: ${message}`);
			}
		},
	});
}

async function startTasksWithCount(sockPath: string, count?: number): Promise<void> {
	const payload = JSON.stringify({
		type: "start_tasks",
		count,
		ts: Date.now(),
	});
	await sendStartTasks(sockPath, payload);
}

function sendStartTasks(sockPath: string, payload: string, timeoutMs = 1500): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;

		const client = net.createConnection({ path: sockPath }, () => {
			client.write(`${payload}\n`);
			client.end();
		});

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				client.destroy();
			} catch (err) {
				logger.debug("agents/extensions/start-tasks.ts: best-effort failure after client.destroy();", { err });
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
