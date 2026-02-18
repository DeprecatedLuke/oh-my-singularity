import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides a `broadcast_to_workers` tool that asks the outer OMS process to
 * evaluate whether a message applies to any running workers.
 *
 * OMS will spawn a steering agent to decide whether to:
 * - steer (notify) running workers
 * - interrupt (abort) running workers
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function broadcastToWorkersExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	const { renderCall, renderResult } = createToolRenderers("Broadcast to Workers", args => {
		const message = typeof args?.message === "string" ? args.message.trim() : "";
		const urgency = typeof args?.urgency === "string" ? args.urgency : "normal";
		return [message ? `message=${message}` : "", `urgency=${urgency}`].filter(Boolean);
	});

	api.registerTool({
		name: "broadcast_to_workers",
		label: "Broadcast to Workers",
		description:
			"Broadcast a coordination message to running workers. OMS will decide who to notify or interrupt. Use when your changes affect ALL running workers simultaneously (shared module changes, type/interface changes, build config changes, global convention changes). Keep messages specific: what changed, files touched, what workers should watch. Never use for single-task corrections.",
		parameters: Type.Object(
			{
				message: Type.String({ description: "Message to broadcast" }),
				urgency: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("critical")])),
			},
			{ additionalProperties: false },
		),
		renderCall,
		renderResult,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const role = process.env.OMS_ROLE ?? "agent";
			const taskId = process.env.OMS_TASK_ID ?? null;

			const payload = {
				type: "broadcast",
				message: typeof params?.message === "string" ? params.message : "",
				urgency: typeof params?.urgency === "string" ? params.urgency : "normal",
				from: {
					role,
					taskId,
				},
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload);
				const error = ipcError(response, "broadcast_to_workers failed");
				if (error) throw new Error(error);
				return {
					content: [{ type: "text", text: "OK (broadcast queued)" }],
				};
			} catch (err) {
				throw new Error(`Failed to broadcast: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
