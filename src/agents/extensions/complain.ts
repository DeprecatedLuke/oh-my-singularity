import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
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

	const { renderCall: complainRenderCall, renderResult: complainRenderResult } = createToolRenderers(
		"Complain",
		args => {
			const files = normalizeFiles(args?.files);
			const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
			const details: string[] = [];
			if (files.length > 0) {
				details.push(`files=${files.join(", ")}`);
			}
			if (reason) {
				details.push(`reason=${reason}`);
			}
			return details;
		},
	);

	const { renderCall: revokeRenderCall, renderResult: revokeRenderResult } = createToolRenderers(
		"Revoke Complaint",
		args => {
			const files = normalizeFiles(args?.files);
			return files.length > 0 ? [`files=${files.join(", ")}`] : ["no files"];
		},
	);

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
		renderCall: complainRenderCall,
		renderResult: complainRenderResult,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

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
				const response = await sendIpc(sockPath, payload, 120_000);
				const error = ipcError(response, "complain failed");
				if (error) throw new Error(error);
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
		renderCall: revokeRenderCall,
		renderResult: revokeRenderResult,
		execute: async (_toolCallId, params) => {
			const sockPath = requireSockPath();

			const files = normalizeFiles(params?.files);
			const payload: UnknownRecord = {
				type: "revoke_complaint",
				complainantAgentId: normalizeEnv(process.env.OMS_AGENT_ID),
				complainantTaskId: normalizeEnv(process.env.OMS_TASK_ID),
				files: files.length > 0 ? files : undefined,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload, 30_000);
				const error = ipcError(response, "revoke_complaint failed");
				if (error) throw new Error(error);
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
