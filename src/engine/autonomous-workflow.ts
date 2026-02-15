import type { TaskIssue } from "../tasks/types";
import type { DispatchOptions, DispatchResult } from "../types/workflow-engine";
import { logger } from "../utils";
import { WorkflowEngine } from "./workflow-engine";

/**
 * AutonomousWorkflowEngine
 * Extends WorkflowEngine with autonomous mode:
 * - Auto-processes ready tasks without human approval
 * - Executes all side effects immediately
 * - Suitable for CI/CD and automated workflows
 */
export class AutonomousWorkflowEngine extends WorkflowEngine {
	/**
	 * Dispatch agent in autonomous mode
	 * Automatically processes side effects without waiting for approval
	 */
	override async dispatchAgent(role: string, task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult> {
		const result = await super.dispatchAgent(role, task, opts);

		if (result.success) {
			logger.debug("AutonomousWorkflowEngine: dispatched agent", {
				role,
				taskId: task.id,
				agent: result.agent?.id,
			});
		}

		return result;
	}
}
