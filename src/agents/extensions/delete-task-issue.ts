import { requireSockPath, sendIpc } from "./ipc-client";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI, UnknownRecord } from "./types";

const TOMBSTONE_REASON = "tombstone: cancelled by user via delete_task_issue";

type TasksRequestResult = {
	ok: boolean;
	data: unknown;
	error: string | null;
	response: UnknownRecord | null;
};

/**
 * OMS extension for omp.
 *
 * Provides a singularity-only `delete_task_issue` tool for explicit user-requested
 * cancellation/deletion flows.
 */
export default async function deleteTaskIssueExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "delete_task_issue",
		label: "Delete Task Issue",
		description:
			"Delete or tombstone a task issue after an explicit user cancel/delete request. " +
			"ONLY use when the user explicitly says to cancel/delete/nuke an issue. Never use for speculative cleanup or autonomous lifecycle decisions. " +
			"Stops all active agents on the issue first (worker, issuer, steering, finisher), then deletes. If hard delete is unavailable, falls back to tombstone close.",
		parameters: Type.Object(
			{
				id: Type.String({
					description: "Issue id to delete/tombstone",
				}),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const id = typeof args?.id === "string" ? args.id.trim() : "";
			return renderToolCall("Delete Task Issue", id ? [`id=${id}`] : [], theme, options);
		},
		renderResult: (result, options, theme) => renderToolResult("Delete Task Issue", result, options, theme),
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const id = typeof params?.id === "string" ? params.id.trim() : "";
			if (!id) {
				throw new Error("delete_task_issue: id is required");
			}
			const actor = process.env.TASKS_ACTOR ?? "oms-singularity";
			const existing = await sendTasksRequest(sockPath, {
				action: "show",
				params: { id },
				actor,
			});
			if (!existing.ok) {
				throw new Error(`delete_task_issue: issue ${id} does not exist`);
			}

			try {
				await sendIpc(
					sockPath,
					{
						type: "stop_agents_for_task",
						taskId: id,
						includeFinisher: true,
						waitForCompletion: true,
						ts: Date.now(),
					},
					30_000,
				);
			} catch (err) {
				const errMsg = err instanceof Error ? err.message : String(err);
				throw new Error(`delete_task_issue: failed to stop agents for ${id}: ${errMsg}`);
			}
			const deleted = await sendTasksRequest(sockPath, {
				action: "delete",
				params: { id },
				actor,
			});
			if (deleted.ok) {
				return {
					content: [{ type: "text", text: `delete_task_issue: stopped agents for ${id}; deleted issue ${id}` }],
					details: {
						id,
						stopped: true,
						mode: "delete",
						result: deleted.data,
					},
				};
			}

			const tombstone = await sendTasksRequest(sockPath, {
				action: "close",
				params: { id, reason: TOMBSTONE_REASON },
				actor,
			});
			if (tombstone.ok) {
				return {
					content: [
						{
							type: "text",
							text:
								`delete_task_issue: stopped agents for ${id}; hard delete failed, ` +
								`tombstoned issue ${id} via close`,
						},
					],
					details: {
						id,
						stopped: true,
						mode: "tombstone",
						deleteError: deleted.error,
						result: tombstone.data,
					},
				};
			}

			const deleteError = deleted.error ?? "delete failed";
			const tombstoneError = tombstone.error ?? "close failed";
			throw new Error(
				`delete_task_issue: stopped agents for ${id}, but deletion failed. delete error: ${deleteError}; tombstone fallback error: ${tombstoneError}`,
			);
		},
	});
}

async function sendTasksRequest(sockPath: string, payload: UnknownRecord): Promise<TasksRequestResult> {
	const response = await sendIpc(
		sockPath,
		{
			type: "tasks_request",
			...payload,
			ts: Date.now(),
		},
		30_000,
	);

	if (!response || response.ok !== true) {
		const message =
			typeof response?.error === "string" && response.error.trim() ? response.error.trim() : "tasks request failed";
		return {
			ok: false,
			data: null,
			error: message,
			response,
		};
	}

	return {
		ok: true,
		data: response.data ?? null,
		error: null,
		response,
	};
}
