import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI, ToolDefinition } from "./types";

type MergerToolName = "merge_complete" | "merge_conflict";
type MergerToolType = "merger_complete" | "merger_conflict";

type MergerToolOptions = {
	name: MergerToolName;
	label: string;
	description: string;
	reasonDescription: string;
	ipcType: MergerToolType;
};

function createMergerTool(
	api: ExtensionAPI,
	opts: MergerToolOptions,
	sockPath: string,
	taskId: string | undefined,
): ToolDefinition {
	const { Type } = api.typebox;
	const errorPrefix = opts.name;

	const { renderCall, renderResult } = createToolRenderers(opts.label, args => {
		const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
		return reason ? [`reason=${reason}`] : ["reason=(missing)"];
	});
	return {
		name: opts.name,
		label: opts.label,
		description: opts.description,
		parameters: Type.Object(
			{
				reason: Type.String({
					description: opts.reasonDescription,
				}),
			},
			{ additionalProperties: false },
		),
		renderCall,
		execute: async (_toolCallId, params) => {
			if (!taskId) {
				throw new Error(`${errorPrefix}: OMS_TASK_ID is missing`);
			}

			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			if (!reason) {
				throw new Error(`${errorPrefix}: reason is required`);
			}

			const agentId = normalizeEnv(process.env.OMS_AGENT_ID);
			const payload = {
				type: opts.ipcType,
				taskId,
				reason,
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload, 30_000);
				const error = ipcError(response, `${errorPrefix} failed`);
				if (error) throw new Error(`${errorPrefix}: ${error}`);

				const summary =
					typeof response.summary === "string" && response.summary.trim()
						? response.summary.trim()
						: `${errorPrefix} recorded for ${taskId}`;

				return {
					content: [{ type: "text", text: summary }],
					details: response,
				};
			} catch (err) {
				throw new Error(`${errorPrefix} IPC failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult,
	};
}
export default async function tasksMergerExtension(api: ExtensionAPI): Promise<void> {
	const sockPath = requireSockPath();
	const taskId = normalizeEnv(process.env.OMS_TASK_ID);
	api.registerTool(
		createMergerTool(
			api,
			{
				name: "merge_complete",
				label: "Merge Complete",
				description: "Report successful replica merge completion to OMS.",
				reasonDescription: "Summary of merged files/changes",
				ipcType: "merger_complete",
			},
			sockPath,
			taskId,
		),
	);

	api.registerTool(
		createMergerTool(
			api,
			{
				name: "merge_conflict",
				label: "Merge Conflict",
				description: "Report an unresolvable merge conflict to OMS.",
				reasonDescription: "Conflict summary including affected file paths",
				ipcType: "merger_conflict",
			},
			sockPath,
			taskId,
		),
	);
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}
