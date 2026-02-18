import net from "node:net";
import { logger } from "../../utils";
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
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const taskId = normalizeEnv(process.env.OMS_TASK_ID);
			if (!taskId) {
				throw new Error("Task scope not configured (OMS_TASK_ID is empty).");
			}

			const context = typeof params?.context === "string" ? params.context.trim() : "";

			const payload = JSON.stringify({
				type: "replace_agent",
				role: "worker",
				taskId,
				context: context || undefined,
				ts: Date.now(),
			});

			try {
				const response = await sendLine(sockPath, payload);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: `replace_agent failed for task ${taskId}`;
					throw new Error(error);
				}
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

function sendLine(sockPath: string, line: string, timeoutMs = 1500): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let settled = false;
	let responseText = "";
	const client = net.createConnection({ path: sockPath }, () => {
		client.write(`${line}\n`);
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
			logger.debug("agents/extensions/steering-replace-agent.ts: best-effort failure after client.destroy();", {
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
			resolve({ ok: true });
			return;
		}
		try {
			resolve(JSON.parse(trimmed));
		} catch {
			resolve(trimmed);
		}
	});
	return promise;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}
