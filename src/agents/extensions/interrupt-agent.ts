import net from "node:net";
import { logger } from "../../utils";

import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides an `interrupt_agent` tool that requests a hard reset for a task by
 * best-effort delivering an urgent message, then force-stopping task agents via the OMS main process.
 *
 * Intended for singularity to relay specific, actionable user feedback
 * (e.g., root cause info, "stop doing X") when the task must be restarted.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function interruptAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description:
			"Hard-reset a task's running agents with an urgent message. " +
			"Message delivery is best-effort; worker/issuer/steering agents on that task are force-stopped. " +
			"Use for relaying specific, actionable user feedback (root cause info, corrections, 'stop what you're doing'). " +
			"Do NOT use for general planning or strategic redirection — use steer_agent when correction doesn't require restart. This does NOT keep the current agent session alive.",
		parameters: Type.Object(
			{
				taskId: Type.String({
					description: "Tasks issue ID the target agent is working on",
				}),
				message: Type.String({
					description: "Urgent message to deliver to the agent",
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
					content: [{ type: "text", text: "interrupt_agent: taskId is required" }],
				};
			}
			if (!message) {
				return {
					content: [{ type: "text", text: "interrupt_agent: message is required" }],
				};
			}

			const payload = JSON.stringify({
				type: "interrupt_agent",
				taskId,
				message,
				ts: Date.now(),
			});

			try {
				await sendLine(sockPath, payload);
				return {
					content: [{ type: "text", text: `OK (interrupt queued for task ${taskId})` }],
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to send interrupt: ${errMsg}`,
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
				logger.debug("agents/extensions/interrupt-agent.ts: best-effort failure after client.destroy();", { err });
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
