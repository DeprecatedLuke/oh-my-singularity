import net from "node:net";
import { logger } from "../../utils";

import { makeTasksExtension } from "./tasks-tool";
import { renderToolCall, renderToolResult } from "./tool-renderers";
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
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
			return renderToolCall("Close Task", reason ? [`reason=${reason}`] : ["reason=(missing)"], theme, options);
		},
		execute: async (_toolCallId, params) => {
			if (!taskId) {
				throw new Error("close_task: OMS_TASK_ID is missing");
			}
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			const effectiveReason = reason || "";
			if (!effectiveReason) {
				throw new Error("close_task: reason is required");
			}
			if (!sockPath.trim()) {
				throw new Error("close_task: OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
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
					throw new Error(`close_task: ${errMsg}`);
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
				throw new Error(`close_task IPC failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("Close Task", result, options, theme),
	});

	api.registerTool({
		name: "advance_lifecycle",
		label: "Advance Lifecycle",
		description:
			"Record the finisher lifecycle decision for OMS. " +
			"Use when the task needs additional work (worker), re-analysis (issuer), or must be deferred.",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("worker"), Type.Literal("issuer"), Type.Literal("defer")], {
					description: "Lifecycle action for this task",
				}),
				message: Type.Optional(
					Type.String({
						description: "Optional kickoff guidance for worker or context for issuer/defer",
					}),
				),
				reason: Type.Optional(
					Type.String({
						description: "Optional reason for the lifecycle decision",
					}),
				),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const action = typeof args?.action === "string" ? args.action.trim() : "";
			const message = typeof args?.message === "string" ? args.message.trim() : "";
			const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
			return renderToolCall(
				"Advance Lifecycle",
				[
					action ? `action=${action}` : "action=(missing)",
					message ? `message=${message}` : "message=(none)",
					reason ? `reason=${reason}` : "reason=(none)",
				],
				theme,
				options,
			);
		},
		execute: async (_toolCallId, params) => {
			if (!sockPath.trim()) {
				throw new Error("advance_lifecycle: OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}
			if (!taskId) {
				throw new Error("advance_lifecycle: OMS_TASK_ID is missing");
			}
			const action = typeof params?.action === "string" ? params.action.trim().toLowerCase() : "";
			if (action !== "worker" && action !== "issuer" && action !== "defer") {
				throw new Error(`advance_lifecycle: unsupported action '${action || "(empty)"}'`);
			}
			const message = typeof params?.message === "string" ? params.message.trim() : "";
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			const agentId = normalizeEnv(process.env.OMS_AGENT_ID);
			const payload = {
				type: "finisher_advance_lifecycle",
				taskId,
				action,
				message: message || undefined,
				reason: reason || undefined,
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendRequest(sockPath, payload, 30_000);
				if (!response || response.ok !== true) {
					const errMsg =
						typeof response?.error === "string" && response.error.trim()
							? response.error.trim()
							: "failed to record lifecycle decision";
					throw new Error(`advance_lifecycle: ${errMsg}`);
				}
				const summary =
					typeof response.summary === "string" && response.summary.trim()
						? response.summary.trim()
						: `advance_lifecycle recorded for ${taskId}: ${action}`;
				return {
					content: [{ type: "text", text: summary }],
					details: response,
				};
			} catch (err) {
				throw new Error(`advance_lifecycle failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("Advance Lifecycle", result, options, theme),
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
	});
}
