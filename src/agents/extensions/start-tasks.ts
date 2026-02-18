import net from "node:net";
import { logger } from "../../utils";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI, UnknownRecord } from "./types";
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
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const count = typeof args?.count === "number" ? `count: ${args.count}` : "";
			const isStreaming = options?.isPartial === true;
			const label = isStreaming ? "Starting Tasks..." : "Started Tasks";
			return renderToolCall(label, isStreaming && count ? [count] : [], theme, options);
		},
		renderResult: (result, options, theme) => {
			const body = renderToolResult("Start Tasks", result, options, theme);
			return {
				render(width: number): string[] {
					const textBlock = result.content.find(block => block.type === "text" && typeof block.text === "string");
					const summaryText = typeof textBlock?.text === "string" ? textBlock.text.trim().toLowerCase() : "";
					if (!summaryText || summaryText === "ok") return [];
					return body.render(width);
				},
			};
		},
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS start-tasks socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}
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
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS start-tasks socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

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
	const response = await sendStartTasks(sockPath, JSON.stringify(payload));
	const responseRecord = asRecord(response);
	if (responseRecord?.ok === false) {
		const error =
			typeof responseRecord.error === "string" && responseRecord.error.trim()
				? responseRecord.error.trim()
				: typeof responseRecord.summary === "string" && responseRecord.summary.trim()
					? responseRecord.summary.trim()
					: "start_tasks failed";
		throw new Error(error);
	}
}

function sendStartTasks(sockPath: string, payload: string, timeoutMs = 1500): Promise<UnknownRecord> {
	const { promise, resolve, reject } = Promise.withResolvers<UnknownRecord>();
	let settled = false;
	let responseText = "";
	const client = net.createConnection({ path: sockPath }, () => {
		client.write(`${payload}\n`);
		client.end();
	});
	const timeout = setTimeout(() => {
		if (settled) return;
		settled = true;
		try {
			client.destroy();
		} catch (err) {
			logger.debug("agents/extensions/start-tasks.ts: best-effort failure after client.destroy();", { err });
		}
		reject(new Error(`Timeout connecting to ${sockPath}`));
	}, timeoutMs);
	client.setEncoding("utf8");
	client.on("data", chunk => {
		responseText += chunk;
	});
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

	return promise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
