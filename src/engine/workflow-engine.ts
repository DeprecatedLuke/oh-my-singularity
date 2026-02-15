import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { getCapabilities } from "../core/capabilities";
import type { PipelineManager } from "../loop/pipeline";
import type { SteeringManager } from "../loop/steering";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import type {
	DispatchOptions,
	DispatchResult,
	DispatchStrategy,
	IWorkflowEngine,
	PostComment,
	SideEffect,
	SpawnFollowUp,
	UpdateTaskStatus,
} from "../types/workflow-engine";
import { logger } from "../utils";
import { DirectSpawnStrategy, RunScoutCycleStrategy, StopSupervisorsThenSpawnStrategy } from "./dispatch-strategies";

/**
 * WorkflowEngine - Base class for orchestrating agent dispatch
 * Implements the facade/wrapper pattern over PipelineManager and SteeringManager
 */
export class WorkflowEngine implements IWorkflowEngine {
	#strategies = new Map<string, DispatchStrategy>();

	constructor(
		private readonly pipelineManager: PipelineManager,
		private readonly steeringManager: SteeringManager,
		private readonly tasksClient: TaskStoreClient,
		private readonly spawner: AgentSpawner,
		private readonly attachRpcHandlers?: (agent: AgentInfo) => void,
		private readonly logAgentStart?: (startedBy: string, agent: AgentInfo, context?: string) => void,
	) {
		this.initializeStrategies();
	}

	private initializeStrategies(): void {
		// Scout strategy - runs issuer and handles skip/defer/start
		this.#strategies.set(
			"scout",
			new RunScoutCycleStrategy((task, opts) => this.pipelineManager.runIssuerForTask(task, opts)),
		);

		// Verifier strategy - stops supervisors then spawns finisher
		this.#strategies.set(
			"verifier",
			new StopSupervisorsThenSpawnStrategy((taskId, workerOutput) =>
				this.steeringManager.spawnFinisherAfterStoppingSteering(taskId, workerOutput),
			),
		);

		// Implementer strategy - direct worker spawn with claim
		this.#strategies.set(
			"implementer",
			new DirectSpawnStrategy((task, opts) => this.pipelineManager.spawnTaskWorker(task, opts)),
		);

		// Supervisor strategy - direct steering agent spawn
		// spawnSteering has different signature, so wrap it
		const supervisorSpawn = (
			task: TaskIssue,
			opts?: { claim?: boolean; kickoffMessage?: string | null },
		): Promise<AgentInfo> => {
			const recentMessages = opts?.kickoffMessage || `Steering for ${task.id}`;
			return this.spawner.spawnSteering(task.id, recentMessages);
		};
		this.#strategies.set(
			"supervisor",
			new DirectSpawnStrategy(supervisorSpawn, true), // isSupervisor flag
		);
	}

	async dispatchAgent(role: string, task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult> {
		// Get capability category for this role
		const caps = getCapabilities(role);
		if (!caps.category) {
			logger.error("dispatchAgent: role has no category", { role, taskId: task.id });
			return {
				success: false,
				reason: `Role ${role} has no category`,
				sideEffects: [],
			};
		}

		// Select strategy by category
		const strategy = this.#strategies.get(caps.category);
		if (!strategy) {
			logger.error("dispatchAgent: no strategy for category", {
				role,
				category: caps.category,
				taskId: task.id,
			});
			return {
				success: false,
				reason: `No dispatch strategy for category: ${caps.category}`,
				sideEffects: [],
			};
		}

		// Execute strategy
		const result = await strategy.execute(task, opts);

		// Execute side effects if successful
		if (result.success) {
			try {
				await this.executeSideEffects(result.sideEffects);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn("dispatchAgent: side effect execution failed (non-fatal)", {
					role,
					taskId: task.id,
					error: message,
				});
				// Continue; side effect failure doesn't invalidate dispatch
			}
		}

		return result;
	}

	async stopSupervisors(taskId: string): Promise<void> {
		try {
			// Delegate to steering manager's generalized method
			if ("stopSupervisors" in this.steeringManager) {
				await (this.steeringManager.stopSupervisors as (id: string) => Promise<void>)(taskId);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("stopSupervisors failed", { taskId, error: message });
			throw err;
		}
	}

	async onVerifierComplete(_taskId: string, _output: string): Promise<void> {
		// Placeholder for future verifier completion hooks
		// Could trigger additional steering or steering termination
	}

	/**
	 * Execute side effects in order: comment → status → spawn
	 * Uses best-effort semantics: if a comment or status update fails, logs a warning
	 * but continues to spawn agents. This ensures task dispatch is not blocked by
	 * transient failures in comment/status updates. Side effects are not atomic —
	 * partial execution is possible.
	 */
	async executeSideEffects(effects: SideEffect[]): Promise<void> {
		if (!Array.isArray(effects) || effects.length === 0) {
			return;
		}

		// Execute in order: comment → status → spawn
		const comments: PostComment[] = [];
		const statuses: UpdateTaskStatus[] = [];
		const spawns: SpawnFollowUp[] = [];

		for (const effect of effects) {
			if (effect.type === "post_comment") {
				comments.push(effect);
			} else if (effect.type === "update_task_status") {
				statuses.push(effect);
			} else if (effect.type === "spawn_followup") {
				spawns.push(effect);
			}
		}

		// Execute comments first
		for (const comment of comments) {
			try {
				await this.tasksClient.comment(comment.taskId, comment.text);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn("Side effect comment failed", {
					taskId: comment.taskId,
					error: message,
				});
			}
		}

		// Execute status updates
		for (const status of statuses) {
			try {
				await this.tasksClient.updateStatus(status.taskId, status.status);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn("Side effect status update failed", {
					taskId: status.taskId,
					status: status.status,
					error: message,
				});
			}
		}

		// Execute spawns
		for (const spawn of spawns) {
			try {
				const result = await this.dispatchAgent(spawn.agentRole, { id: spawn.taskId } as TaskIssue, {
					context: spawn.context,
				});
				if (result.success && result.agent && this.attachRpcHandlers && this.logAgentStart) {
					this.attachRpcHandlers(result.agent);
					this.logAgentStart("WorkflowEngine", result.agent, spawn.context);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.warn("Side effect spawn failed", {
					taskId: spawn.taskId,
					role: spawn.agentRole,
					error: message,
				});
			}
		}
	}

	/**
	 * Get pending side effects for a task (for manual review)
	 * Base implementation returns empty (override in InteractiveWorkflowEngine)
	 */
	getPendingSideEffects(_taskId: string): SideEffect[] {
		return [];
	}

	/**
	 * Approve and execute pending side effects for a task
	 * Base implementation is a no-op (override in InteractiveWorkflowEngine)
	 */
	async approveSideEffects(_taskId: string): Promise<void> {
		// No-op in base class
	}

	/**
	 * Reject pending side effects for a task
	 * Base implementation is a no-op (override in InteractiveWorkflowEngine)
	 */
	rejectSideEffects(_taskId: string): void {
		// No-op in base class
	}
}
