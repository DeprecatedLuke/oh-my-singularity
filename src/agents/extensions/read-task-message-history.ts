import net from "node:net";
import { logger } from "../../utils";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI, UnknownRecord } from "./types";

/**
 * OMS extension for steering agents.
 *
 * Provides scoped read-only access to agents and message history on the current task:
 * - list_task_agents()
 * - read_message_history(agentId, limit)
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 * Task scope is read from env: OMS_TASK_ID
 */
export default async function readTaskMessageHistoryExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "list_task_agents",
		label: "List Task Agents",
		description:
			"List OMS agents assigned to the current task. Task-scoped: only shows agents on YOUR current task, cannot inspect unrelated tasks. Returns id, role, state, and lastActivity.",
		parameters: Type.Object({}, { additionalProperties: false }),
		mergeCallAndResult: true,
		renderCall: (_args, theme, options) => renderToolCall("List Task Agents", ["no args"], theme, options),
		execute: async () => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const taskId = normalizeEnv(process.env.OMS_TASK_ID);
			if (!taskId) {
				throw new Error("Task scope not configured (OMS_TASK_ID is empty).");
			}

			try {
				const response = await sendRequest(
					sockPath,
					{
						type: "list_task_agents",
						taskId,
						ts: Date.now(),
					},
					15_000,
				);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: typeof responseRecord.summary === "string" && responseRecord.summary.trim()
								? responseRecord.summary.trim()
								: "list_task_agents failed";
					throw new Error(error);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
					details: response,
				};
			} catch (err) {
				throw new Error(`list_task_agents failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("List Task Agents", result, options, theme),
	});

	api.registerTool({
		name: "read_message_history",
		label: "Read Message History",
		description:
			"Read recent message history for an agent on the current task. Task-scoped: can only read history for agents on YOUR current task. Use when the static snapshot looks stale, to detect stuck loops, inspect repeated tool errors, or confirm worker approach before steering.",
		parameters: Type.Object(
			{
				agentId: Type.String({ description: "Registry agent id" }),
				limit: Type.Optional(
					Type.Number({
						description: "Max recent items to return (default 40)",
						minimum: 1,
						maximum: 200,
					}),
				),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const agentId = typeof args?.agentId === "string" ? args.agentId.trim() : "";
			const limit = typeof args?.limit === "number" ? args.limit : 40;
			const details = [agentId ? `agentId=${agentId}` : "agentId=(missing)", `limit=${limit}`];
			return renderToolCall("Read Message History", details, theme, options);
		},
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const taskId = normalizeEnv(process.env.OMS_TASK_ID);
			if (!taskId) {
				throw new Error("Task scope not configured (OMS_TASK_ID is empty).");
			}

			const agentId = typeof params?.agentId === "string" ? params.agentId.trim() : "";
			if (!agentId) {
				throw new Error("read_message_history: agentId is required");
			}

			const parsedLimit = Number(params?.limit);
			const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(200, Math.trunc(parsedLimit)) : 40;

			try {
				const response = await sendRequest(
					sockPath,
					{
						type: "read_message_history",
						taskId,
						agentId,
						limit,
						ts: Date.now(),
					},
					20_000,
				);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: typeof responseRecord.summary === "string" && responseRecord.summary.trim()
								? responseRecord.summary.trim()
								: "read_message_history failed";
					throw new Error(error);
				}
				return {
					content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
					details: response,
				};
			} catch (err) {
				throw new Error(`read_message_history failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("Read Message History", result, options, theme),
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function sendRequest(sockPath: string, payload: unknown, timeoutMs = 1_500): Promise<UnknownRecord> {
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
				logger.debug(
					"agents/extensions/read-task-message-history.ts: best-effort failure after client.destroy();",
					{ err },
				);
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
				resolve({ ok: true });
				return;
			}

			try {
				const parsed = JSON.parse(trimmed);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					resolve({ ok: true, data: parsed });
					return;
				}
				resolve(parsed as UnknownRecord);
			} catch {
				resolve({ ok: true, text: trimmed });
			}
		});
	});
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
