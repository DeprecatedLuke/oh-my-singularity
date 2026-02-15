import type { TaskIssue } from "../tasks/types";
import type { DispatchOptions, DispatchResult, SideEffect } from "../types/workflow-engine";
import { logger } from "../utils";
import { WorkflowEngine } from "./workflow-engine";

/**
 * InteractiveWorkflowEngine
 * Extends WorkflowEngine with interactive mode:
 * - Requires human approval for task transitions
 * - Queues side effects for manual confirmation
 * - Suitable for high-assurance workflows with human oversight
 */
export class InteractiveWorkflowEngine extends WorkflowEngine {
	#sideEffectQueue = new Map<string, SideEffect[]>();

	/**
	 * Dispatch agent in interactive mode
	 * Queues side effects instead of auto-executing them
	 */
	override async dispatchAgent(role: string, task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult> {
		const result = await super.dispatchAgent(role, task, opts);

		if (result.success) {
			// Queue side effects for manual approval instead of auto-executing
			if (result.sideEffects.length > 0) {
				// Merge with existing effects to avoid overwriting on concurrent dispatch
				const existing = this.#sideEffectQueue.get(task.id) ?? [];
				this.#sideEffectQueue.set(task.id, [...existing, ...result.sideEffects]);
				logger.debug("InteractiveWorkflowEngine: queued side effects", {
					role,
					taskId: task.id,
					effectCount: result.sideEffects.length,
				});
			}
		}

		return result;
	}

	/**
	 * Get pending side effects for a task (for manual review)
	 */
	override getPendingSideEffects(taskId: string): SideEffect[] {
		return this.#sideEffectQueue.get(taskId) ?? [];
	}

	/**
	 * Approve and execute pending side effects for a task
	 */
	override async approveSideEffects(taskId: string): Promise<void> {
		const effects = this.#sideEffectQueue.get(taskId);
		if (!effects) {
			logger.warn("approveSideEffects: no pending effects", { taskId });
			return;
		}

		try {
			await this.executeSideEffects(effects);
			this.#sideEffectQueue.delete(taskId);
			logger.debug("InteractiveWorkflowEngine: approved side effects", {
				taskId,
				effectCount: effects.length,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("approveSideEffects failed", { taskId, error: message });
			throw err;
		}
	}

	/**
	 * Reject pending side effects for a task
	 */
	override rejectSideEffects(taskId: string): void {
		const effects = this.#sideEffectQueue.get(taskId);
		if (effects) {
			this.#sideEffectQueue.delete(taskId);
			logger.debug("InteractiveWorkflowEngine: rejected side effects", {
				taskId,
				effectCount: effects.length,
			});
		}
	}
}
