import net from "node:net";
import { logger } from "../../utils";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI, UnknownRecord } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides worker conflict tools:
 * - complain(files, reason)
 * - revoke_complaint(files?)
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function complainExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "complain",
		label: "Complain",
		description:
			"Report concurrent edits on files you are actively changing. Use when another agent is editing the same files you are actively modifying. " +
			"OMS will spawn a resolver agent to identify the conflicting worker and ask it to wait.",
		parameters: Type.Object(
			{
				files: Type.Array(Type.String({ description: "Repository-relative file path currently contested" }), {
					minItems: 1,
				}),
				reason: Type.String({
					description: "Why this is a conflict / what you are currently doing",
				}),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const files = normalizeFiles(args?.files);
			const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
			const details: string[] = [];
			if (files.length > 0) {
				details.push(`files=${files.join(", ")}`);
			}
			if (reason) {
				details.push(`reason=${reason}`);
			}
			return renderToolCall("Complain", details, theme, options);
		},
		renderResult: (result, options, theme) => renderToolResult("Complain", result, options, theme),
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const files = normalizeFiles(params?.files);
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			if (files.length === 0) {
				throw new Error("complain: files must contain at least one non-empty path");
			}

			if (!reason) {
				throw new Error("complain: reason is required");
			}

			const payload = {
				type: "complain",
				complainantAgentId: normalizeEnv(process.env.OMS_AGENT_ID),
				complainantTaskId: normalizeEnv(process.env.OMS_TASK_ID),
				files,
				reason,
				ts: Date.now(),
			};

			try {
				const response = await sendRequest(sockPath, payload, 120_000);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: typeof responseRecord.summary === "string" && responseRecord.summary.trim()
								? responseRecord.summary.trim()
								: "complain failed";
					throw new Error(error);
				}
				const text = formatResponseText(response, "complain");
				return {
					content: [{ type: "text", text }],
					details: response,
				};
			} catch (err) {
				throw new Error(`complain failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	api.registerTool({
		name: "revoke_complaint",
		label: "Revoke Complaint",
		description:
			"Signal that you are done with previously contested files so waiting agents can resume. Use when you finish editing contested files and want paused agents to continue.",
		parameters: Type.Object(
			{
				files: Type.Optional(
					Type.Array(Type.String({ description: "Repository-relative file path(s) to revoke complaints for" }), {
						minItems: 1,
					}),
				),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const files = normalizeFiles(args?.files);
			return renderToolCall(
				"Revoke Complaint",
				files.length > 0 ? [`files=${files.join(", ")}`] : ["no files"],
				theme,
				options,
			);
		},
		renderResult: (result, options, theme) => renderToolResult("Revoke Complaint", result, options, theme),
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const files = normalizeFiles(params?.files);
			const payload: UnknownRecord = {
				type: "revoke_complaint",
				complainantAgentId: normalizeEnv(process.env.OMS_AGENT_ID),
				complainantTaskId: normalizeEnv(process.env.OMS_TASK_ID),
				files: files.length > 0 ? files : undefined,
				ts: Date.now(),
			};

			try {
				const response = await sendRequest(sockPath, payload, 30_000);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: typeof responseRecord.summary === "string" && responseRecord.summary.trim()
								? responseRecord.summary.trim()
								: "revoke_complaint failed";
					throw new Error(error);
				}
				const text = formatResponseText(response, "revoke_complaint");
				return {
					content: [{ type: "text", text }],
					details: response,
				};
			} catch (err) {
				throw new Error(`revoke_complaint failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
}

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function normalizeFiles(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const unique = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim().replace(/^\.\//, "");
		if (!normalized) continue;
		unique.add(normalized);
	}
	return [...unique];
}

function formatResponseText(response: unknown, toolName: string): string {
	if (!response || typeof response !== "object") {
		return `${toolName}: ${String(response)}`;
	}

	const rec = response as UnknownRecord;
	const summary = typeof rec.summary === "string" && rec.summary.trim() ? rec.summary.trim() : null;
	if (summary) return summary;

	return `${toolName} response:\n${JSON.stringify(response, null, 2)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function sendRequest(sockPath: string, payload: unknown, timeoutMs = 1_500): Promise<unknown> {
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
				logger.debug("agents/extensions/complain.ts: best-effort failure after client.destroy();", { err });
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
				resolve({ ok: true, text: trimmed });
			}
		});
	});
}
