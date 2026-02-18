import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for steering agents.
 *
 * Provides scoped read-only access to agents and message history on the current task:
 * - list_task_agents()
 * - read_message_history(agentId, limit)
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 * Task scope is read from env: OMS_TASK_ID
 */
export default async function readTaskMessageHistoryExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "list_task_agents",
		label: "List Task Agents",
		description:
			"List OMS agents assigned to the current task. Task-scoped: only shows agents on YOUR current task, cannot inspect unrelated tasks. Returns id, role, state, and lastActivity.",
		parameters: Type.Object({}, { additionalProperties: false }),
		mergeCallAndResult: true,
		renderCall: (_args, theme, options) => renderToolCall("List Task Agents", ["no args"], theme, options),
		execute: async () => {
			const sockPath = requireSockPath();

			const taskId = normalizeEnv(process.env.OMS_TASK_ID);
			if (!taskId) {
				throw new Error("Task scope not configured (OMS_TASK_ID is empty).");
			}

			try {
				const response = await sendIpc(
					sockPath,
					{
						type: "list_task_agents",
						taskId,
						ts: Date.now(),
					},
					15_000,
				);
				const error = ipcError(response, "list_task_agents failed");
				if (error) throw new Error(error);
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
					details: response,
				};
			} catch (err) {
				throw new Error(`list_task_agents failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("List Task Agents", result, options, theme),
	});

	api.registerTool({
		name: "read_message_history",
		label: "Read Message History",
		description:
			"Read recent message history for an agent on the current task. Task-scoped: can only read history for agents on YOUR current task. Use when the static snapshot looks stale, to detect stuck loops, inspect repeated tool errors, or confirm worker approach before steering.",
		parameters: Type.Object(
			{
				agentId: Type.String({ description: "Registry agent id" }),
				limit: Type.Optional(
					Type.Number({
						description: "Max recent items to return (default 40)",
						minimum: 1,
						maximum: 200,
					}),
				),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const agentId = typeof args?.agentId === "string" ? args.agentId.trim() : "";
			const limit = typeof args?.limit === "number" ? args.limit : 40;
			const details = [agentId ? `agentId=${agentId}` : "agentId=(missing)", `limit=${limit}`];
			return renderToolCall("Read Message History", details, theme, options);
		},
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const taskId = normalizeEnv(process.env.OMS_TASK_ID);
			if (!taskId) {
				throw new Error("Task scope not configured (OMS_TASK_ID is empty).");
			}

			const agentId = typeof params?.agentId === "string" ? params.agentId.trim() : "";
			if (!agentId) {
				throw new Error("read_message_history: agentId is required");
			}

			const parsedLimit = Number(params?.limit);
			const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(200, Math.trunc(parsedLimit)) : 40;

			try {
				const response = await sendIpc(
					sockPath,
					{
						type: "read_message_history",
						taskId,
						agentId,
						limit,
						ts: Date.now(),
					},
					20_000,
				);
				const error = ipcError(response, "read_message_history failed");
				if (error) throw new Error(error);
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
					details: response,
				};
			} catch (err) {
				throw new Error(`read_message_history failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("Read Message History", result, options, theme),
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
