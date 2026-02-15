import type { AgentInfo } from "../agents/types";
import type { TaskIssue } from "../tasks/types";

/**
 * Side effect to spawn a follow-up agent
 */
export type SpawnFollowUp = {
	type: "spawn_followup";
	agentRole: string;
	taskId: string;
	context?: string;
};

/**
 * Side effect to update task status
 */
export type UpdateTaskStatus = {
	type: "update_task_status";
	taskId: string;
	status: string;
};

/**
 * Side effect to post a task comment
 */
export type PostComment = {
	type: "post_comment";
	taskId: string;
	text: string;
};

/**
 * Union of all possible side effects
 */
export type SideEffect = SpawnFollowUp | UpdateTaskStatus | PostComment;

/**
 * Result of a dispatch strategy execution
 */
export type DispatchResult = {
	success: boolean;
	agent?: AgentInfo;
	message?: string;
	reason?: string;
	sideEffects: SideEffect[];
};

/**
 * Options passed to dispatch strategies
 */
export type DispatchOptions = {
	context?: string;
};

/**
 * Dispatch strategy interface
 */
export interface DispatchStrategy {
	execute(task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult>;
}

/**
 * WorkflowEngine interface for agent dispatch
 */
export interface IWorkflowEngine {
	/**
	 * Dispatch an agent for a task based on role and category
	 */
	dispatchAgent(role: string, task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult>;

	/**
	 * Stop all supervisor (steering) agents for a task
	 */
	stopSupervisors(taskId: string): Promise<void>;

	/**
	 * Notify engine when a verifier agent completes
	 */
	onVerifierComplete(taskId: string, output: string): Promise<void>;

	/**
	 * Execute side effects in order: comment → status → spawn
	 */
	executeSideEffects(effects: SideEffect[]): Promise<void>;

	/**
	 * Get pending side effects for a task (for manual review)
	 */
	getPendingSideEffects(taskId: string): SideEffect[];

	/**
	 * Approve and execute pending side effects for a task
	 */
	approveSideEffects(taskId: string): Promise<void>;

	/**
	 * Reject pending side effects for a task
	 */
	rejectSideEffects(taskId: string): void;
}

/**
 * Configuration for WorkflowEngine behavior
 */
export type WorkflowEngineConfig = {
	/** If true, auto-process ready tasks; if false, queue for manual approval */
	autonomous: boolean;
};
