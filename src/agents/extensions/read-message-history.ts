import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for resolver agents.
 *
 * Provides read-only access to active agents and recent message history:
 * - list_active_agents()
 * - read_message_history(agentId, limit)
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function readMessageHistoryExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	const { renderCall: listRenderCall, renderResult: listRenderResult } = createToolRenderers(
		"List Active Agents",
		() => ["no args"],
	);

	const { renderCall: historyRenderCall, renderResult: historyRenderResult } = createToolRenderers(
		"Read Message History",
		args => {
			const agentId = typeof args?.agentId === "string" ? args.agentId.trim() : "";
			const limit = typeof args?.limit === "number" ? args.limit : 40;
			return [agentId ? `agentId=${agentId}` : "agentId=(missing)", `limit=${limit}`];
		},
	);

	api.registerTool({
		name: "list_active_agents",
		label: "List Active Agents",
		description: "List active OMS agents with role/task metadata.",
		parameters: Type.Object({}, { additionalProperties: false }),
		renderCall: listRenderCall,
		execute: async () => {
			const sockPath = requireSockPath();

			try {
				const response = await sendIpc(sockPath, { type: "list_active_agents", ts: Date.now() }, 15_000);
				const error = ipcError(response, "list_active_agents failed");
				if (error) throw new Error(error);
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
					details: response,
				};
			} catch (err) {
				throw new Error(`list_active_agents failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: listRenderResult,
	});

	api.registerTool({
		name: "read_message_history",
		label: "Read Message History",
		description: "Read recent message history for a running agent to inspect tool usage.",
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
		renderCall: historyRenderCall,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();
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
		renderResult: historyRenderResult,
	});
}
