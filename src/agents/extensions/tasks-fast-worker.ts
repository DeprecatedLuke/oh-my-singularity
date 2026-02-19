import { ipcError, requireSockPath, sendIpc } from "./ipc-client";

import { makeTasksExtension } from "./tasks-tool";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

const registerFastWorkerTasksTool = makeTasksExtension({
	role: "fast-worker",
	allowedActions: ["show", "list", "search", "ready", "comments", "comment_add", "query", "dep_tree", "types"],
});

export default async function tasksFastWorkerExtension(api: ExtensionAPI): Promise<void> {
	await registerFastWorkerTasksTool(api);
	const { Type } = api.typebox;
	const { renderCall: closeRenderCall, renderResult: closeRenderResult } = createToolRenderers("Close Task", args => {
		const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
		return reason ? [`reason=${reason}`] : ["reason=(missing)"];
	});
	const { renderCall: advanceRenderCall, renderResult: advanceRenderResult } = createToolRenderers(
		"Advance Lifecycle",
		args => {
			const action = typeof args?.action === "string" ? args.action.trim() : "";
			const message = typeof args?.message === "string" ? args.message.trim() : "";
			const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
			return [
				action ? `action=${action}` : "action=(missing)",
				message ? `message=${message}` : "message=(none)",
				reason ? `reason=${reason}` : "reason=(none)",
			];
		},
	);
	const sockPath = requireSockPath();
	const taskId = normalizeEnv(process.env.OMS_TASK_ID);

	api.registerTool({
		name: "close_task",
		label: "Close Task",
		description: "Close the current task via OMS IPC when tiny-scope work is complete.",
		parameters: Type.Object(
			{
				reason: Type.String({
					description: "Brief completion reason recorded with the task close",
				}),
			},
			{ additionalProperties: false },
		),
		renderCall: closeRenderCall,
		renderResult: closeRenderResult,
		execute: async (_toolCallId, params) => {
			if (!taskId) {
				throw new Error("close_task: OMS_TASK_ID is missing");
			}
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			if (!reason) {
				throw new Error("close_task: reason is required");
			}
			const agentId = normalizeEnv(process.env.OMS_AGENT_ID);
			const payload = {
				type: "fast_worker_close_task",
				taskId,
				reason,
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload, 30_000);
				const error = ipcError(response, "close_task failed");
				if (error) throw new Error(`close_task: ${error}`);
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
	});

	api.registerTool({
		name: "advance_lifecycle",
		label: "Advance Lifecycle",
		description:
			"Record the fast-worker lifecycle decision for OMS. " +
			"Call exactly once with action=done|escalate so OMS can continue pipeline orchestration.",
		parameters: Type.Object(
			{
				action: Type.Union([Type.Literal("done"), Type.Literal("escalate")], {
					description: "Lifecycle action for this task",
				}),
				message: Type.Optional(
					Type.String({
						description: "Optional completion summary (done) or escalation context (escalate)",
					}),
				),
				reason: Type.Optional(
					Type.String({
						description: "Optional reason (recommended for escalation decisions)",
					}),
				),
			},
			{ additionalProperties: false },
		),
		renderCall: advanceRenderCall,
		renderResult: advanceRenderResult,
		execute: async (_toolCallId, params) => {
			if (!taskId) {
				throw new Error("advance_lifecycle: OMS_TASK_ID is missing");
			}
			const action = typeof params?.action === "string" ? params.action.trim().toLowerCase() : "";
			if (action !== "done" && action !== "escalate") {
				throw new Error(`advance_lifecycle: unsupported action '${action || "(empty)"}'`);
			}
			const message = typeof params?.message === "string" ? params.message.trim() : "";
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			const agentId = normalizeEnv(process.env.OMS_AGENT_ID);
			const payload = {
				type: "fast_worker_advance_lifecycle",
				taskId,
				action,
				message: message || undefined,
				reason: reason || undefined,
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload, 30_000);
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
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
