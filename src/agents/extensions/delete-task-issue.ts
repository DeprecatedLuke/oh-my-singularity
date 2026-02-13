import net from "node:net";
import { logger } from "../../utils";

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
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				return {
					content: [
						{
							type: "text",
							text: "OMS socket not configured (OMS_SINGULARITY_SOCK is empty).",
						},
					],
				};
			}

			const id = typeof params?.id === "string" ? params.id.trim() : "";
			if (!id) {
				return {
					content: [{ type: "text", text: "delete_task_issue: id is required" }],
				};
			}

			try {
				await sendRequest(
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
				return {
					content: [
						{
							type: "text",
							text: `delete_task_issue: failed to stop agents for ${id}: ${errMsg}`,
						},
					],
					details: {
						id,
						stopped: false,
						deleted: false,
						error: errMsg,
					},
				};
			}

			const actor = process.env.TASKS_ACTOR ?? "oms-singularity";
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
			return {
				content: [
					{
						type: "text",
						text:
							`delete_task_issue: stopped agents for ${id}, but deletion failed. ` +
							`delete error: ${deleteError}; tombstone fallback error: ${tombstoneError}`,
					},
				],
				details: {
					id,
					stopped: true,
					deleted: false,
					deleteError,
					tombstoneError,
					deleteResponse: deleted.response,
					tombstoneResponse: tombstone.response,
				},
			};
		},
	});
}

async function sendTasksRequest(sockPath: string, payload: UnknownRecord): Promise<TasksRequestResult> {
	const response = await sendRequest(
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

function sendRequest(sockPath: string, payload: unknown, timeoutMs = 1500): Promise<UnknownRecord> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let responseText = "";

		const client = net.createConnection({ path: sockPath }, () => {
			client.write(`${JSON.stringify(payload)}\n`);
			client.end();
		});

		client.setEncoding("utf8");
		client.on("data", chunk => {
			responseText += chunk;
		});

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				client.destroy();
			} catch (err) {
				logger.debug("agents/extensions/delete-task-issue.ts: best-effort failure after client.destroy();", {
					err,
				});
			}
			reject(new Error(`Timeout connecting to ${sockPath}`));
		}, timeoutMs);

		client.on("error", err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(err);
		});

		client.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);

			const trimmed = responseText.trim();
			if (!trimmed || trimmed === "ok") {
				resolve({ ok: true, data: null });
				return;
			}

			try {
				const parsed = JSON.parse(trimmed);
				resolve(asUnknownRecord(parsed, { ok: true, data: parsed }));
			} catch {
				resolve({ ok: true, data: trimmed });
			}
		});
	});
}

function asUnknownRecord(value: unknown, fallback: UnknownRecord): UnknownRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
	return value as UnknownRecord;
}
