import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides an `interrupt_agent` tool that gracefully stops task agents and queues
 * an urgent interrupt message for delivery on restart.
 *
 * Intended for singularity to relay specific, actionable user feedback
 * (e.g., root cause info, "stop doing X") when the task must be restarted.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function interruptAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	const { renderCall, renderResult } = createToolRenderers("Interrupt Agent", args => {
		const taskId = typeof args?.taskId === "string" ? args.taskId.trim() : "";
		const message = typeof args?.message === "string" ? args.message.trim() : "";
		return [taskId ? `taskId=${taskId}` : "", message ? `message=${message}` : ""].filter(Boolean);
	});

	api.registerTool({
		name: "interrupt_agent",
		label: "Interrupt Agent",
		description:
			"Gracefully stop task agents and queue an urgent interrupt message for delivery on restart. " +
			"Agents are stopped gracefully (like pressing Esc in TUI), and the message is delivered when they resume. " +
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
		renderCall,
		renderResult,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
			const message = typeof params?.message === "string" ? params.message.trim() : "";

			if (!taskId) {
				throw new Error("interrupt_agent: taskId is required");
			}

			if (!message) {
				throw new Error("interrupt_agent: message is required");
			}

			const payload = {
				type: "interrupt_agent",
				taskId,
				message,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload);
				const error = ipcError(response, `interrupt_agent failed for task ${taskId}`);
				if (error) throw new Error(error);

				return {
					content: [{ type: "text", text: `OK (interrupt queued for task ${taskId})` }],
				};
			} catch (err) {
				throw new Error(`Failed to send interrupt: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
