import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for steering agents.
 *
 * Provides a scoped `resume_agent` tool that requests a worker replacement
 * for the current task only.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 * Task scope is read from env: OMS_TASK_ID
 */
export default async function steeringReplaceAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "resume_agent",
		label: "Resume Agent",
		description:
			"Spawn a fresh worker agent for the current task. Context becomes the worker's kickoff steering message. Use when work stalled, needs new direction, or resuming after interruption. Steering controls workers only — cannot spawn issuers/finishers.",
		parameters: Type.Object(
			{
				context: Type.Optional(
					Type.String({
						description: "Kickoff context for the new worker",
					}),
				),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const context = typeof args?.context === "string" ? args.context.trim() : "";
			return renderToolCall("Resume Agent", [context ? `context=${context}` : "context=(none)"], theme, options);
		},
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const taskId = normalizeEnv(process.env.OMS_TASK_ID);
			if (!taskId) {
				throw new Error("Task scope not configured (OMS_TASK_ID is empty).");
			}

			const context = typeof params?.context === "string" ? params.context.trim() : "";

			const payload = {
				type: "replace_agent",
				role: "worker",
				taskId,
				context: context || undefined,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload);
				const error = ipcError(response, `replace_agent failed for task ${taskId}`);
				if (error) throw new Error(error);
				return {
					content: [
						{
							type: "text",
							text: `OK (replace_agent queued: worker for task ${taskId})`,
						},
					],
				};
			} catch (err) {
				throw new Error(`Failed to request worker resume: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("Resume Agent", result, options, theme),
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
