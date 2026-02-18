import net from "node:net";
import { logger } from "../../utils";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type { ExtensionAPI, UnknownRecord } from "./types";

/**
 * OMS extension for omp.
 *
 * Provides `wait_for_agent(agentId)` to block until a specific agent exits.
 *
 * Socket path is read from env: OMS_SINGULARITY_SOCK
 */
export default async function waitForAgentExtension(api: ExtensionAPI): Promise<void> {
	const { Type } = api.typebox;

	api.registerTool({
		name: "wait_for_agent",
		label: "Wait For Agent",
		description:
			"Block until the specified agent has completed or exited. Use when your next step depends on a specific agent finishing its work. This is a blocking operation that will pause your execution.",
		parameters: Type.Object(
			{
				agentId: Type.String({ description: "Registry agent id to wait for" }),
			},
			{ additionalProperties: false },
		),
		mergeCallAndResult: true,
		renderCall: (args, theme, options) => {
			const agentId = typeof args?.agentId === "string" ? args.agentId.trim() : "";
			return renderToolCall(
				"Wait For Agent",
				agentId ? [`agentId=${agentId}`] : ["agentId=(missing)"],
				theme,
				options,
			);
		},
		execute: async (_toolCallId, params) => {
			const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
			if (!sockPath.trim()) {
				throw new Error("OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
			}

			const agentId = typeof params?.agentId === "string" ? params.agentId.trim() : "";
			if (!agentId) {
				throw new Error("wait_for_agent: agentId is required");
			}

			const payload = {
				type: "wait_for_agent",
				requesterAgentId: normalizeEnv(process.env.OMS_AGENT_ID),
				requesterTaskId: normalizeEnv(process.env.OMS_TASK_ID),
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendRequest(sockPath, payload, 24 * 60 * 60 * 1000);
				const responseRecord = asRecord(response);
				if (responseRecord?.ok === false) {
					const error =
						typeof responseRecord.error === "string" && responseRecord.error.trim()
							? responseRecord.error.trim()
							: typeof responseRecord.summary === "string" && responseRecord.summary.trim()
								? responseRecord.summary.trim()
								: "wait_for_agent failed";
					throw new Error(error);
				}
				return {
					content: [{ type: "text", text: `wait_for_agent response:\n${JSON.stringify(response, null, 2)}` }],
					details: response,
				};
			} catch (err) {
				throw new Error(`wait_for_agent failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult: (result, options, theme) => renderToolResult("Wait For Agent", result, options, theme),
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
				logger.debug("agents/extensions/wait-for-agent.ts: best-effort failure after client.destroy();", { err });
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
