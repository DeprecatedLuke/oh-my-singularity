import type { AgentInfo } from "../agents/types";
import type { TaskIssue } from "../tasks/types";
import type {
	DispatchOptions,
	DispatchResult,
	DispatchStrategy,
	PostComment,
	SpawnFollowUp,
	UpdateTaskStatus,
} from "../types/workflow-engine";
import { logger } from "../utils";

/**
 * RunScoutCycleStrategy
 * Wraps PipelineManager.runIssuerForTask() for scout/issuer dispatch
 * Returns skip/defer/start decision with appropriate side effects
 */
export class RunScoutCycleStrategy implements DispatchStrategy {
	constructor(
		private readonly runIssuerForTask: (
			task: TaskIssue,
			opts?: { kickoffMessage?: string },
		) => Promise<{
			start: boolean;
			skip?: boolean;
			message: string | null;
			reason: string | null;
			raw: string | null;
		}>,
	) {}

	async execute(task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult> {
		try {
			const result = await this.runIssuerForTask(task, {
				kickoffMessage: opts?.context || undefined,
			});

			// Case 1: Skip - no worker needed
			if (result.skip) {
				const skipReason = result.reason || result.message || "No implementation work needed";
				const finisherInput =
					`[Issuer skip — no worker spawned]\n\n` +
					`The issuer determined no implementation work is needed for this task.\n` +
					`Reason: ${skipReason}`;

				const sideEffects: (PostComment | UpdateTaskStatus | SpawnFollowUp)[] = [
					{
						type: "post_comment",
						taskId: task.id,
						text: `Issuer skip: ${skipReason}`,
					},
					{
						type: "spawn_followup",
						agentRole: "finisher",
						taskId: task.id,
						context: finisherInput,
					},
				];

				return {
					success: true,
					message: `Issuer skip for ${task.id}`,
					reason: skipReason,
					sideEffects,
				};
			}

			// Case 2: Defer - no action now
			if (!result.start) {
				const reason = result.reason || "Issuer deferred start";
				const sideEffects: (UpdateTaskStatus | PostComment)[] = [
					{
						type: "post_comment",
						taskId: task.id,
						text: `Issuer deferred. ${reason}${result.message ? `\n${result.message}` : ""}`,
					},
					{
						type: "update_task_status",
						taskId: task.id,
						status: "blocked",
					},
				];

				return {
					success: true,
					message: `Issuer deferred for ${task.id}`,
					reason,
					sideEffects,
				};
			}

			// Case 3: Start - spawn worker
			const startMessage = result.message || null;
			const sideEffects: SpawnFollowUp[] = [
				{
					type: "spawn_followup",
					agentRole: "implementer",
					taskId: task.id,
					context: startMessage || undefined,
				},
			];

			return {
				success: true,
				message: `Issuer started worker for ${task.id}`,
				sideEffects,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("RunScoutCycleStrategy failed", { taskId: task.id, error: message });
			return {
				success: false,
				reason: message,
				sideEffects: [],
			};
		}
	}
}

/**
 * StopSupervisorsThenSpawnStrategy
 * Wraps SteeringManager.spawnFinisherAfterStoppingSteering() for verifier dispatch
 * Stops all steering agents then spawns finisher
 */
export class StopSupervisorsThenSpawnStrategy implements DispatchStrategy {
	constructor(
		private readonly spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<AgentInfo>,
	) {}

	async execute(task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult> {
		try {
			const finisherInput = opts?.context || "[Spawned by singularity for lifecycle recovery]";

			const agent = await this.spawnFinisherAfterStoppingSteering(task.id, finisherInput);

			const sideEffects: PostComment[] = [
				{
					type: "post_comment",
					taskId: task.id,
					text: `Finisher spawned: ${agent.id}`,
				},
			];

			return {
				success: true,
				agent,
				message: `Finisher spawned for ${task.id}`,
				sideEffects,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("StopSupervisorsThenSpawnStrategy failed", { taskId: task.id, error: message });
			return {
				success: false,
				reason: message,
				sideEffects: [],
			};
		}
	}
}

/**
 * DirectSpawnStrategy
 * Wraps PipelineManager.spawnTaskWorker() for implementer dispatch
 * or AgentSpawner.spawnSteering() for supervisor dispatch
 */
export class DirectSpawnStrategy implements DispatchStrategy {
	constructor(
		private readonly spawn: (
			task: TaskIssue,
			opts?: { claim?: boolean; kickoffMessage?: string | null },
		) => Promise<AgentInfo>,
		private readonly isSupervisor: boolean = false,
	) {}

	async execute(task: TaskIssue, opts?: DispatchOptions): Promise<DispatchResult> {
		try {
			const agent = await this.spawn(task, {
				claim: !this.isSupervisor,
				kickoffMessage: opts?.context || undefined,
			});

			const sideEffects: PostComment[] = [
				{
					type: "post_comment",
					taskId: task.id,
					text: `Agent spawned: ${agent.role} (${agent.id})`,
				},
			];

			return {
				success: true,
				agent,
				message: `${this.isSupervisor ? "Supervisor" : "Worker"} spawned for ${task.id}`,
				sideEffects,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("DirectSpawnStrategy failed", {
				taskId: task.id,
				error: message,
				supervisor: this.isSupervisor,
			});
			return {
				success: false,
				reason: message,
				sideEffects: [],
			};
		}
	}
}
