import type { IWorkflowEngine, SideEffect } from "../../types/workflow-engine";
import type { ExtensionAPI } from "./types";

/**
 * Summarize a side effect as human-readable text (max 80 chars)
 */
function summarizeSideEffect(effect: SideEffect): string {
	const maxLen = 80;
	switch (effect.type) {
		case "post_comment":
			return `Comment: '${effect.text.slice(0, 50)}${effect.text.length > 50 ? "..." : ""}'`.slice(0, maxLen);
		case "update_task_status":
			return `Update task status to ${effect.status}`.slice(0, maxLen);
		case "spawn_followup":
			return `Spawn ${effect.agentRole} task`.slice(0, maxLen);
		default:
			return "Unknown side effect".slice(0, maxLen);
	}
}

/**
 * Get pending side effects for a task
 */
async function getPendingSideEffects(
	api: ExtensionAPI,
	{ taskId }: { taskId: string },
): Promise<{
	taskId: string;
	effectCount: number;
	effects: Array<{ type: string; summary: string }>;
}> {
	try {
		const engine = (api as unknown as { workflowEngine?: IWorkflowEngine }).workflowEngine;

		if (!engine) {
			return {
				taskId,
				effectCount: 0,
				effects: [],
			};
		}

		const effects = engine.getPendingSideEffects(taskId);
		return {
			taskId,
			effectCount: effects.length,
			effects: effects.map((effect: SideEffect) => ({
				type: effect.type,
				summary: summarizeSideEffect(effect),
			})),
		};
	} catch (_err) {
		return {
			taskId,
			effectCount: 0,
			effects: [],
		};
	}
}

/**
 * Approve and execute side effects for a task
 */
async function approveSideEffects(
	api: ExtensionAPI,
	{ taskId }: { taskId: string },
): Promise<{
	approved: boolean;
	taskId: string;
}> {
	try {
		const engine = (api as unknown as { workflowEngine?: IWorkflowEngine }).workflowEngine;

		if (!engine) {
			throw new Error("Workflow engine not available");
		}

		await engine.approveSideEffects(taskId);
		return {
			approved: true,
			taskId,
		};
	} catch (err) {
		throw new Error(`Failed to approve side effects: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Reject and discard side effects for a task
 */
async function rejectSideEffects(
	api: ExtensionAPI,
	{ taskId }: { taskId: string },
): Promise<{
	rejected: boolean;
	taskId: string;
}> {
	try {
		const engine = (api as unknown as { workflowEngine?: IWorkflowEngine }).workflowEngine;

		if (!engine) {
			throw new Error("Workflow engine not available");
		}

		engine.rejectSideEffects(taskId);
		return {
			rejected: true,
			taskId,
		};
	} catch (err) {
		throw new Error(`Failed to reject side effects: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Register PM mode side effect approval tools
 */
export function registerPmSideEffectTools(api: ExtensionAPI): void {
	const { Type } = api.typebox;
	api.registerTool({
		name: "get_pending_side_effects",
		label: "Get Pending Side Effects",
		description: "Get list of side effects queued for approval on a task (PM mode only)",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to check for pending side effects" }),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as { taskId: string };
			const result = await getPendingSideEffects(api, input);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result),
					},
				],
			};
		},
	});

	api.registerTool({
		name: "approve_side_effects",
		label: "Approve Side Effects",
		description: "Approve and execute all queued side effects for a task",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to approve side effects for" }),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as { taskId: string };
			const result = await approveSideEffects(api, input);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result),
					},
				],
			};
		},
	});

	api.registerTool({
		name: "reject_side_effects",
		label: "Reject Side Effects",
		description: "Reject and discard all queued side effects for a task",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task ID to reject side effects for" }),
		}),
		execute: async (_toolCallId, params) => {
			const input = params as { taskId: string };
			const result = await rejectSideEffects(api, input);
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result),
					},
				],
			};
		},
	});
}
