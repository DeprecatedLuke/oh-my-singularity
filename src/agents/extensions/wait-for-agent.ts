import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides `wait_for_agent(agentId)` to block until a specific agent exits.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function waitForAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	const { renderCall, renderResult } = createToolRenderers("Wait For Agent", args => {
		const agentId = typeof args?.agentId === "string" ? args.agentId.trim() : "";
		return agentId ? [`agentId=${agentId}`] : ["agentId=(missing)"];
	});

	api.registerTool({
		name: "wait_for_agent",
		label: "Wait For Agent",
		description:
			"Block until the specified agent has completed or exited. Use when your next step depends on a specific agent finishing its work. This is a blocking operation that will pause your execution.",
		parameters: Type.Object(
			{
				agentId: Type.String({ description: "Registry agent id to wait for" }),
			},
			{ additionalProperties: false },
		),
		renderCall,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const agentId = typeof params?.agentId === "string" ? params.agentId.trim() : "";
			if (!agentId) {
				throw new Error("wait_for_agent: agentId is required");
			}

			const payload = {
				type: "wait_for_agent",
				requesterAgentId: normalizeEnv(process.env.OMS_AGENT_ID),
				requesterTaskId: normalizeEnv(process.env.OMS_TASK_ID),
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload, 24 * 60 * 60 * 1000);
				const error = ipcError(response, "wait_for_agent failed");
				if (error) throw new Error(error);
				return {
					content: [{ type: "text", text: `wait_for_agent response:\n${JSON.stringify(response, null, 2)}` }],
					details: response,
				};
			} catch (err) {
				throw new Error(`wait_for_agent failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult,
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
