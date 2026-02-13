import net from "node:net";
import { logger } from "../../utils";

import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides a `replace_agent` tool that lets singularity request the main OMS
 * process to replace lifecycle agents (finisher, issuer, worker) for recovery
 * and orchestration scenarios.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function replaceAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "replace_agent",
		label: "Replace Agent",
		description:
			"Replace or start a lifecycle agent for a specific task. If an agent of that role is already running, this kills it and spawns a fresh replacement; if none exists, this starts one. " +
			"Use when an agent is stuck, dead, or on the wrong approach and needs a clean restart. " +
			"For blocked tasks needing unblock/close, replace with a finisher. " +
			"For tasks needing fresh analysis, replace with an issuer (runs full issuer→worker pipeline). " +
			"For tasks where you already know the implementation guidance, replace with a worker directly.",
		parameters: Type.Object(
			{
				role: Type.Union([Type.Literal("finisher"), Type.Literal("issuer"), Type.Literal("worker")], {
					description: "Agent role to replace",
				}),
				taskId: Type.String({
					description: "Tasks issue ID to replace the agent for",
				}),
				context: Type.Optional(
					Type.String({
						description:
							"Context for the replacement agent. " +
							"For finisher: acts as worker output / recovery reason. " +
							"For worker: acts as kickoff steering message. " +
							"For issuer: ignored (issuer reads the task from tasks).",
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
							text: "OMS socket not configured (OMS_SINGULARITY_SOCK is empty).",
						},
					],
				};
			}

			const role = typeof params?.role === "string" ? params.role.trim() : "";
			const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
			const context = typeof params?.context === "string" ? params.context.trim() : "";

			if (!role || !["finisher", "issuer", "worker"].includes(role)) {
				return {
					content: [
						{
							type: "text",
							text: "replace_agent: role must be one of: finisher, issuer, worker",
						},
					],
				};
			}

			if (!taskId) {
				return {
					content: [{ type: "text", text: "replace_agent: taskId is required" }],
				};
			}

			const payload = JSON.stringify({
				type: "replace_agent",
				role,
				taskId,
				context: context || undefined,
				ts: Date.now(),
			});

			try {
				await sendLine(sockPath, payload);
				return {
					content: [
						{
							type: "text",
							text: `OK (replace_agent queued: ${role} for task ${taskId})`,
						},
					],
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `Failed to request agent replacement: ${errMsg}`,
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
				logger.debug("agents/extensions/replace-agent.ts: best-effort failure after client.destroy();", { err });
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
