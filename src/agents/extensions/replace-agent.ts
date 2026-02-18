import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides a `replace_agent` tool that lets singularity request the main OMS
 * process to replace lifecycle agents (finisher, issuer, worker) for recovery
 * and orchestration scenarios.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function replaceAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "replace_agent",
		label: "Replace Agent",
		description:
			"Replace or start a lifecycle agent for a specific task. If an agent of that role is already running, this kills it and spawns a fresh replacement; if none exists, this starts one. " +
			"Use when an agent is stuck, dead, or on the wrong approach and needs a clean restart. " +
			"For blocked tasks needing unblock/close, replace with a finisher. " +
			"For tasks needing fresh analysis, replace with an issuer (runs full issuer→worker pipeline). " +
			"For tasks where you already know the implementation guidance, replace with a worker directly.",
		parameters: Type.Object(
			{
				role: Type.Union([Type.Literal("finisher"), Type.Literal("issuer"), Type.Literal("worker")], {
					description: "Agent role to replace",
				}),
				taskId: Type.String({
					description: "Tasks issue ID to replace the agent for",
				}),
				context: Type.Optional(
					Type.String({
						description:
							"Context for the replacement agent. " +
							"For finisher: acts as worker output / recovery reason. " +
							"For worker: acts as kickoff steering message. " +
							"For issuer: ignored (issuer reads the task from tasks).",
					}),
				),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const role = typeof args?.role === "string" ? args.role.trim() : "";
			const taskId = typeof args?.taskId === "string" ? args.taskId.trim() : "";
			const context = typeof args?.context === "string" ? args.context.trim() : "";
			const details = [
				role ? `role=${role}` : "",
				taskId ? `taskId=${taskId}` : "",
				context ? `context=${context}` : "",
			];
			return renderToolCall("Replace Agent", details.filter(Boolean), theme, options);
		},
		renderResult: (result, options, theme) => renderToolResult("Replace Agent", result, options, theme),
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const role = typeof params?.role === "string" ? params.role.trim() : "";
			const taskId = typeof params?.taskId === "string" ? params.taskId.trim() : "";
			const context = typeof params?.context === "string" ? params.context.trim() : "";

			if (!role || !["finisher", "issuer", "worker"].includes(role)) {
				throw new Error("replace_agent: role must be one of: finisher, issuer, worker");
			}

			if (!taskId) {
				throw new Error("replace_agent: taskId is required");
			}

			const payload = {
				type: "replace_agent",
				role,
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
							text: `OK (replace_agent queued: ${role} for task ${taskId})`,
						},
					],
				};
			} catch (err) {
				throw new Error(`Failed to request agent replacement: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}
