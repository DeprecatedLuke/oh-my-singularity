import { getAgentLifecycleConfig, type LifecycleAction } from "../../config/constants";
import { ipcError, requireSockPath, sendIpc } from "./ipc-client";
import { createToolRenderers } from "./tool-renderers";
import type { ExtensionAPI } from "./types";

function normalizeEnv(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * Register the `advance_lifecycle` tool for a given agent.
 *
 * Reads allowed actions and advance targets from AGENT_CONFIGS —
 * no per-agent hardcoding. Adding a new agent = config entry + prompt file.
 */
export function registerAdvanceLifecycleTool(api: ExtensionAPI, agent: string): void {
	const config = getAgentLifecycleConfig(agent);
	if (!config) {
		throw new Error(`registerAdvanceLifecycleTool: no lifecycle config for agent "${agent}"`);
	}

	const { Type } = api.typebox;
	const sockPath = requireSockPath();
	const taskId = normalizeEnv(process.env.OMS_TASK_ID);

	const allowedActions = [...config.allowedActions];
	const targets = config.allowedAdvanceTargets;

	const { renderCall, renderResult } = createToolRenderers("Advance Lifecycle", args => {
		const action = typeof args?.action === "string" ? args.action.trim() : "";
		const target = typeof args?.target === "string" ? args.target.trim() : "";
		const message = typeof args?.message === "string" ? args.message.trim() : "";
		const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
		const parts = [action ? `action=${action}` : "action=(missing)"];
		if (target) parts.push(`target=${target}`);
		parts.push(message ? `message=${message}` : "message=(none)");
		if (reason) parts.push(`reason=${reason}`);
		return parts;
	});

	const actionsDesc = allowedActions.map(a => `'${a}'`).join(", ");
	const targetsDesc = targets.length > 0 ? ` Valid advance targets: ${targets.join(", ")}.` : "";

	api.registerTool({
		name: "advance_lifecycle",
		label: "Advance Lifecycle",
		description: `Signal lifecycle transition. Available actions: ${actionsDesc}.${targetsDesc}`,
		parameters: Type.Object(
			{
				action: Type.Union(
					allowedActions.map(a => Type.Literal(a)),
					{ description: `Lifecycle action: ${actionsDesc}` },
				),
				target: Type.Optional(
					Type.String({
						description:
							targets.length > 0
								? `Target agent when action is advance (${targets.join(" or ")})`
								: "Target agent when action is advance",
					}),
				),
				message: Type.Optional(Type.String({ description: "Optional summary of what changed" })),
				reason: Type.Optional(Type.String({ description: "Optional reason for the lifecycle decision" })),
			},
			{ additionalProperties: false },
		),
		renderCall,
		execute: async (_toolCallId, params) => {
			if (!taskId) {
				throw new Error("advance_lifecycle: OMS_TASK_ID is missing");
			}
			const action = typeof params?.action === "string" ? params.action.trim().toLowerCase() : "";
			if (!config.allowedActions.has(action as LifecycleAction)) {
				const allowed = [...config.allowedActions].map(a => `'${a}'`).join(", ");
				throw new Error(`advance_lifecycle: unsupported action '${action || "(empty)"}'; must be ${allowed}`);
			}
			const target = typeof params?.target === "string" ? params.target.trim().toLowerCase() : "";
			if (action === "advance") {
				if (!target) {
					throw new Error("advance_lifecycle: target is required when action is 'advance'");
				}
				if (!targets.includes(target)) {
					throw new Error(`advance_lifecycle: invalid target '${target}'; valid targets: ${targets.join(", ")}`);
				}
			}
			const message = typeof params?.message === "string" ? params.message.trim() : "";
			const reason = typeof params?.reason === "string" ? params.reason.trim() : "";
			const agentId = normalizeEnv(process.env.OMS_AGENT_ID);
			const payload = {
				type: "advance_lifecycle",
				agentType: agent,
				taskId,
				action,
				target: target || "",
				message: message || undefined,
				reason: reason || undefined,
				agentId,
				ts: Date.now(),
			};

			try {
				const response = await sendIpc(sockPath, payload, 30_000);
				const error = ipcError(response, "failed to record lifecycle decision");
				if (error) throw new Error(`advance_lifecycle: ${error}`);
				const summary =
					typeof response.summary === "string" && response.summary.trim()
						? response.summary.trim()
						: `advance_lifecycle recorded for ${taskId}: ${action}${target ? ` -> ${target}` : ""}`;
				return {
					content: [{ type: "text", text: summary }],
					details: response,
				};
			} catch (err) {
				throw new Error(`advance_lifecycle failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		renderResult,
	});
}
