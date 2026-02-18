import net from "node:net";
import { logger } from "../../utils";

import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides a `steer_agent` tool that delivers a steering message to agents
 * running on a specific task without stopping them.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function steerAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "steer_agent",
		label: "Steer Agent",
		description:
			"Deliver a steering message to a task's running agents without killing them (soft redirect). " +
			"The agent keeps running and applies the guidance. Use for corrections, directives, and newly discovered context the active agent should apply immediately. Prefer this over interrupt_agent when correction doesn't require restart.",
		parameters: Type.Object(
			{
				taskId: Type.String({
					description: "Tasks issue ID the target agent is working on",
				}),
				message: Type.String({
					description: "Steering message to deliver to the running agent",
				}),
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
							text: "OMS socket not configured (OMS_SINGULARITY_SOCK is empty).",
						},
					],
				};
			}

			const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
			const message = typeof params?.message === "string" ? params.message.trim() : "";

			if (!taskId) {
				return {
					content: [{ type: "text", text: "steer_agent: taskId is required" }],
				};
			}
			if (!message) {
				return {
					content: [{ type: "text", text: "steer_agent: message is required" }],
				};
			}

			const payload = JSON.stringify({
				type: "steer_agent",
				taskId,
				message,
				ts: Date.now(),
			});

			try {
				await sendLine(sockPath, payload);
				return {
					content: [{ type: "text", text: `OK (steer queued for task ${taskId})` }],
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to send steer message: ${errMsg}`,
						},
					],
					details: { sockPath, error: errMsg },
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
				logger.debug("agents/extensions/steer-agent.ts: best-effort failure after client.destroy();", { err });
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
