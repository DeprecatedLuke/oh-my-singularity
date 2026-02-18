import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";
/**
 * OMS extension for omp.
 *
 * Provides a `start_tasks` tool that signals the outer OMS process
 * via a unix domain socket.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function omsStartTasksExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;
	const { renderCall, renderResult } = createToolRenderers({ pending: "Start Tasks", done: "Started Tasks" }, args => {
		const count = typeof args?.count === "number" ? `count: ${args.count}` : "";
		return count ? [count] : [];
	});
	api.registerTool({
		name: "start_tasks",
		label: "Start Tasks",
		description:
			"Trigger OMS to check for ready tasks and start issuers immediately. Use this after creating new tasks or unblocking existing tasks to begin the issuer→worker pipeline.",
		parameters: Type.Object(
			{
				count: Type.Optional(
					Type.Number({
						description: "Optional maximum number of tasks to start",
						minimum: 0,
					}),
				),
			},
			{ additionalProperties: false },
		),
		renderCall,
		renderResult,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();
			const count = typeof params?.count === "number" ? params.count : undefined;
			try {
				await startTasksWithCount(sockPath, count);
				return {
					content: [{ type: "text", text: "OK" }],
				};
			} catch (err) {
				throw new Error(`Failed to send start_tasks to OMS: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
	api.registerCommand?.("start", {
		description: "Trigger OMS to check for ready tasks and start issuers immediately.",
		handler: async (_context: unknown) => {
			const sockPath = requireSockPath();

			try {
				await startTasksWithCount(sockPath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Failed to send start_tasks to OMS: ${message}`);
			}
		},
	});
}
async function startTasksWithCount(sockPath: string, count?: number): Promise<void> {
	const payload = {
		type: "start_tasks",
		count,
		ts: Date.now(),
	};
	const response = await sendIpc(sockPath, payload);
	const error = ipcError(response, "start_tasks failed");
	if (error) throw new Error(error);
}
