import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { renderToolCall, renderToolResult } from "./tool-renderers";
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
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const taskId = typeof args?.taskId === "string" ? args.taskId.trim() : "";
			const message = typeof args?.message === "string" ? args.message.trim() : "";
			return renderToolCall(
				"Steer Agent",
				[taskId ? `taskId=${taskId}` : "", message ? `message=${message}` : ""],
				theme,
				options,
			);
		},
		renderResult: (result, options, theme) => renderToolResult("Steer Agent", result, options, theme),
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
			const message = typeof params?.message === "string" ? params.message.trim() : "";

			if (!taskId) {
				throw new Error("steer_agent: taskId is required");
			}

			if (!message) {
				throw new Error("steer_agent: message is required");
			}

			const payload = {
				type: "steer_agent",
				taskId,
				message,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload);
				const error = ipcError(response, `steer_agent failed for task ${taskId}`);
				if (error) throw new Error(error);

				return {
					content: [{ type: "text", text: `OK (steer queued for task ${taskId})` }],
				};
			} catch (err) {
				throw new Error(`Failed to send steer message: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
