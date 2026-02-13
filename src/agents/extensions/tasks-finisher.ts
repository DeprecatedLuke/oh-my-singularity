import net from "node:net";
import { logger } from "../../utils";

import { makeTasksExtension } from "./tasks-tool";
import type { ExtensionAPI, UnknownRecord } from "./types";

const registerFinisherTasksTool = makeTasksExtension({
	role: "finisher",
	allowedActions: [
		"show",
		"list",
		"search",
		"ready",
		"comments",
		"comment_add",
		"query",
		"dep_tree",
		"types",
		"create",
		"update",
	],
});

export default async function tasksFinisherExtension(api: ExtensionAPI): Promise<void> {
	await registerFinisherTasksTool(api);
	const { Type } = api.typebox;
	const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
	const taskId = normalizeEnv(process.env.OMS_TASK_ID);

	api.registerTool({
		name: "close_task",
		label: "Close Task",
		description: "Close the current task via OMS IPC so the finisher can be aborted immediately.",
		parameters: Type.Object(
			{
				reason: Type.String({
					description: "Brief reason recorded with the task close",
				}),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			if (!taskId) {
				return {
					content: [{ type: "text", text: "close_task: OMS_TASK_ID is missing" }],
				};
			}
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			const effectiveReason = reason || "";
			if (!effectiveReason) {
				return {
					content: [{ type: "text", text: "close_task: reason is required" }],
				};
			}
			if (!sockPath.trim()) {
				return {
					content: [
						{
							type: "text",
							text: "close_task: OMS socket not configured (OMS_SINGULARITY_SOCK is empty).",
						},
					],
				};
			}
			const agentId = normalizeEnv(process.env.OMS_AGENT_ID);
			const payload = {
				type: "finisher_close_task",
				taskId,
				reason: effectiveReason,
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendRequest(sockPath, payload, 30_000);
				if (!response || response.ok !== true) {
					const errMsg =
						typeof response?.error === "string" && response.error.trim()
							? response.error.trim()
							: "failed to notify OMS";
					return {
						content: [{ type: "text", text: `close_task: ${errMsg}` }],
						details: response,
					};
				}
				const summary =
					typeof response.summary === "string" && response.summary.trim()
						? response.summary.trim()
						: `close_task completed for ${taskId}`;
				return {
					content: [{ type: "text", text: summary }],
					details: response,
				};
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `close_task IPC failed: ${errMsg}` }],
					details: { sockPath, error: errMsg },
				};
			}
		},
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function sendRequest(sockPath: string, payload: unknown, timeoutMs = 1_500): Promise<UnknownRecord> {
	return new Promise((resolve, reject) => {
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
				logger.debug("agents/extensions/tasks-finisher.ts: best-effort failure after client.destroy();", { err });
			}
			reject(new Error(`Timeout connecting to ${sockPath}`));
		}, timeoutMs);

		client.on("error", err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(err);
		});

		client.on("close_task".slice(0, 5), () => {
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
	});
}
