import { MergerQueue } from "../agents/merger-queue";
import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { DEFAULT_CONFIG, type OmsConfig } from "../config";
import { ReplicaManager } from "../replica/manager";
import type { SessionLogWriter } from "../session-log-writer";
import type { TaskStoreClient } from "../tasks/client";
import { logger } from "../utils";
import { ComplaintManager } from "./complaints";
import { LifecycleHelpers } from "./lifecycle-helpers";
import { PipelineManager } from "./pipeline";
import { RpcHandlerManager } from "./rpc-handlers";
import type { Scheduler } from "./scheduler";
import { SteeringManager } from "./steering";

function isTerminalStatus(status: string | undefined): boolean {
	return status === "done" || status === "aborted" || status === "stopped" || status === "dead";
}

export class AgentLoop {
	private readonly tasksClient: TaskStoreClient;
	private readonly registry: AgentRegistry;
	private readonly scheduler: Scheduler;
	private readonly spawner: AgentSpawner;
	private readonly config: OmsConfig;
	private readonly onDirty?: () => void;
	private readonly logAgentId?: string;

	private timer: Timer | null = null;
	private running = false;
	private paused = false;
	private tickInFlight = false;
	private pendingWake = false;

	private readonly steeringManager: SteeringManager;
	private readonly complaintManager: ComplaintManager;
	private readonly lifecycleHelpers: LifecycleHelpers;
	private readonly rpcHandlerManager: RpcHandlerManager;
	private readonly pipelineManager: PipelineManager;
	private readonly spawnAgentInFlight = new Set<string>();
	private readonly lifecycleTransitionInFlight = new Set<string>();

	#mergerQueue = new MergerQueue();
	#replicaManager: ReplicaManager | null;
	#mergerQueueRestored = false;
	#mergerQueueProcessing = false;
	#mergerQueueRunning = false;

	constructor(opts: {
		tasksClient: TaskStoreClient;
		registry: AgentRegistry;
		scheduler: Scheduler;
		spawner: AgentSpawner;
		config?: OmsConfig;
		onDirty?: () => void;
		logAgentId?: string;
		crashLogWriter?: SessionLogWriter;
	}) {
		this.tasksClient = opts.tasksClient;
		this.registry = opts.registry;
		this.scheduler = opts.scheduler;
		this.spawner = opts.spawner;
		this.config = opts.config ?? DEFAULT_CONFIG;
		this.onDirty = opts.onDirty;
		this.logAgentId = opts.logAgentId;

		const replicaManagerFromSpawner = (
			this.spawner as unknown as { getReplicaManager?: () => ReplicaManager | undefined }
		).getReplicaManager?.();
		if (replicaManagerFromSpawner) {
			this.#replicaManager = replicaManagerFromSpawner;
		} else {
			const maybeWorkingDir = (this.tasksClient as { workingDir?: unknown }).workingDir;
			const workingDir = typeof maybeWorkingDir === "string" ? maybeWorkingDir.trim() : "";
			this.#replicaManager = workingDir ? new ReplicaManager({ projectRoot: workingDir }) : null;
		}
		this.lifecycleHelpers = new LifecycleHelpers({
			registry: this.registry,
			loopLog: this.loopLog.bind(this),
			crashLogWriter: opts.crashLogWriter,
		});
		this.rpcHandlerManager = new RpcHandlerManager({
			registry: this.registry,
			tasksClient: this.tasksClient,
			loopLog: this.loopLog.bind(this),
			onDirty: this.onDirty,
			isRunning: () => this.running,
			isPaused: () => this.paused,
			wake: this.wake.bind(this),
			revokeComplaint: opts => this.complaintManager.revokeComplaint(opts),
			spawnFinisherAfterStoppingSteering: (taskId, workerOutput, resumeSessionId) =>
				this.withLifecycleTransition(taskId, () =>
					this.steeringManager.spawnFinisherAfterStoppingSteering(taskId, workerOutput, resumeSessionId),
				),
			getLastAssistantText: this.lifecycleHelpers.getLastAssistantText.bind(this.lifecycleHelpers),
			logAgentStart: this.lifecycleHelpers.logAgentStart.bind(this.lifecycleHelpers),
			logAgentFinished: this.lifecycleHelpers.logAgentFinished.bind(this.lifecycleHelpers),
			writeAgentCrashLog: this.lifecycleHelpers.writeAgentCrashLog.bind(this.lifecycleHelpers),
			takeFinisherLifecycleAdvance: taskId => this.pipelineManager.takeFinisherLifecycleAdvance(taskId),
			takeFinisherCloseRecord: taskId => this.pipelineManager.takeFinisherCloseRecord(taskId),
			spawnWorkerFromFinisherAdvance: async (taskId, kickoffMessage) =>
				this.withLifecycleTransition(taskId, async () => {
					const task = await this.tasksClient.show(taskId);
					return await this.pipelineManager.spawnTaskWorker(task, {
						claim: false,
						kickoffMessage: kickoffMessage ?? null,
					});
				}),
			kickoffIssuerFromFinisherAdvance: async (taskId, _kickoffMessage) =>
				this.withLifecycleTransition(taskId, async () => {
					const task = await this.tasksClient.show(taskId);
					if (task.status === "blocked") {
						this.loopLog(`Skipped issuer kickoff for blocked task ${taskId}`, "info", { taskId });
						return;
					}
					this.pipelineManager.kickoffResumePipeline(task);
				}),
		});

		const attachRpcHandlers = this.rpcHandlerManager.attachRpcHandlers.bind(this.rpcHandlerManager);
		const finishAgent = this.rpcHandlerManager.finishAgent.bind(this.rpcHandlerManager);
		const logAgentStart = this.lifecycleHelpers.logAgentStart.bind(this.lifecycleHelpers);
		const logAgentFinished = this.lifecycleHelpers.logAgentFinished.bind(this.lifecycleHelpers);
		this.steeringManager = new SteeringManager({
			registry: this.registry,
			spawner: this.spawner,
			config: this.config,
			loopLog: this.loopLog.bind(this),
			onDirty: this.onDirty,
			attachRpcHandlers,
			finishAgent,
			logAgentStart,
			logAgentFinished,
			stopAgentsMatching: this.stopAgentsMatching.bind(this),
		});
		this.complaintManager = new ComplaintManager({
			registry: this.registry,
			spawner: this.spawner,
			loopLog: this.loopLog.bind(this),
			onDirty: this.onDirty,
			attachRpcHandlers,
			finishAgent,
			logAgentStart,
			logAgentFinished,
			steerAgent: this.steerAgent.bind(this),
		});
		this.pipelineManager = new PipelineManager({
			tasksClient: this.tasksClient,
			registry: this.registry,
			scheduler: this.scheduler,
			spawner: this.spawner,
			getMaxWorkers: () => this.config.maxWorkers,
			getActiveWorkerAgents: () => this.steeringManager.getActiveWorkerAgents(),
			loopLog: this.loopLog.bind(this),
			onDirty: this.onDirty,
			wake: this.wake.bind(this),
			attachRpcHandlers,
			finishAgent,
			logAgentStart,
			logAgentFinished,
			hasPendingInterruptKickoff: taskId => this.steeringManager.hasPendingInterruptKickoff(taskId),
			takePendingInterruptKickoff: taskId => this.steeringManager.takePendingInterruptKickoff(taskId),
			hasFinisherTakeover: taskId => this.steeringManager.hasFinisherTakeover(taskId),
			spawnFinisherAfterStoppingSteering: (taskId, workerOutput, resumeSessionId) =>
				this.withLifecycleTransition(taskId, () =>
					this.steeringManager.spawnFinisherAfterStoppingSteering(taskId, workerOutput, resumeSessionId),
				),
			isRunning: () => this.running,
			isPaused: () => this.paused,
		});
	}

	private loopLog(message: string, level: "debug" | "info" | "warn" | "error" = "info", data?: unknown): void {
		const id = this.logAgentId;
		if (!id) return;

		this.registry.pushEvent(id, {
			type: "log",
			ts: Date.now(),
			level,
			message,
			data,
		});
		this.onDirty?.();
	}

	private isLifecycleTransitionInFlight(taskId: string): boolean {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		return this.lifecycleTransitionInFlight.has(normalizedTaskId);
	}

	private async withLifecycleTransition<T>(taskId: string, callback: () => Promise<T>): Promise<T> {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return callback();

		this.lifecycleTransitionInFlight.add(normalizedTaskId);
		try {
			return await callback();
		} finally {
			this.lifecycleTransitionInFlight.delete(normalizedTaskId);
		}
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.paused = false;

		this.loopLog("Agent loop started", "info", {
			pollIntervalMs: this.config.pollIntervalMs,
			maxWorkers: this.config.maxWorkers,
		});

		this.registry.startHeartbeat();
		void this.#restoreMergerQueueFromReplicas();

		void this.tick();

		this.timer = setInterval(() => {
			void this.tick();
		}, this.config.pollIntervalMs);
	}

	isPaused(): boolean {
		return this.paused;
	}

	isRunning(): boolean {
		return this.running;
	}

	async pause(): Promise<void> {
		if (!this.running) return;
		if (this.paused) return;
		this.paused = true;
		this.loopLog("Agent loop paused", "info");

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}

		try {
			await this.registry.stopHeartbeat();
		} catch (err) {
			logger.debug("loop/agent-loop.ts: best-effort failure after await this.registry.stopHeartbeat();", { err });
		}

		this.onDirty?.();
	}

	resume(): void {
		if (!this.running) return;
		if (!this.paused) return;
		this.paused = false;
		this.loopLog("Agent loop resumed", "info");

		this.registry.startHeartbeat();

		if (!this.timer) {
			this.timer = setInterval(() => {
				void this.tick();
			}, this.config.pollIntervalMs);
		}

		this.onDirty?.();
		void this.tick();
	}

	setPollIntervalMs(intervalMs: number): void {
		const parsed = Number(intervalMs);
		if (!Number.isFinite(parsed) || parsed <= 0) return;

		this.config.pollIntervalMs = Math.max(100, Math.trunc(parsed));

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = setInterval(() => {
				void this.tick();
			}, this.config.pollIntervalMs);
		}

		this.loopLog("Agent loop poll interval updated", "info", {
			pollIntervalMs: this.config.pollIntervalMs,
		});
		this.onDirty?.();
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.paused = false;

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}

		for (const agent of this.registry.getActive()) {
			const rpc = agent.rpc;
			if (rpc && rpc instanceof OmsRpcClient) {
				try {
					await rpc.stop();
				} catch (err) {
					logger.debug("loop/agent-loop.ts: best-effort failure after await rpc.stop();", { err });
				}
			}

			try {
				await this.tasksClient.setAgentState(agent.tasksAgentId, "stopped");
			} catch (err) {
				logger.debug(
					'loop/agent-loop.ts: best-effort failure after await this.tasksClient.setAgentState(agent.tasksAgentId, "stopped");',
					{ err },
				);
			}

			try {
				await this.tasksClient.clearSlot(agent.tasksAgentId, "hook");
			} catch (err) {
				logger.debug(
					'loop/agent-loop.ts: best-effort failure after await this.tasksClient.clearSlot(agent.tasksAgentId, "hook");',
					{ err },
				);
			}
		}

		await this.registry.stopHeartbeat();
	}

	/** Wake the loop soon (coalesced). */
	wake(): void {
		if (!this.running) return;
		if (this.paused) return;
		if (this.pendingWake) return;
		this.pendingWake = true;

		setTimeout(() => {
			this.pendingWake = false;
			void this.tick();
		}, 0);
	}

	/** Start ready issuers up to available capacity and begin pipelines.
	 *
	 * @param count - Optional max number of issuers to start.
	 */
	async startTasks(count?: number): Promise<{ spawned: number; taskIds: string[] }> {
		if (!this.running) return { spawned: 0, taskIds: [] };
		if (this.paused) return { spawned: 0, taskIds: [] };

		const normalizedCount = typeof count === "number" && Number.isFinite(count) ? Math.trunc(count) : 0;
		let slots =
			normalizedCount > 0
				? Math.min(normalizedCount, this.pipelineManager.availableWorkerSlots())
				: this.pipelineManager.availableWorkerSlots();
		slots = Math.max(0, slots);
		if (slots <= 0) return { spawned: 0, taskIds: [] };

		const candidates = await this.scheduler.getNextTasks(slots);
		const spawned: string[] = [];

		for (const task of candidates) {
			if (slots <= 0 || this.paused) break;
			if (this.pipelineManager.isPipelineInFlight(task.id) || this.isLifecycleTransitionInFlight(task.id)) {
				continue;
			}
			this.pipelineManager.kickoffNewTaskPipeline(task);
			spawned.push(task.id);
			slots -= 1;
		}

		this.onDirty?.();
		return { spawned: spawned.length, taskIds: spawned };
	}

	async broadcastToWorkers(message: string, meta?: unknown): Promise<void> {
		if (!this.running) return;
		await this.steeringManager.broadcastToWorkers(message, meta);
	}

	advanceIssuerLifecycle(opts: {
		taskId?: string;
		action?: string;
		message?: string;
		reason?: string;
		agentId?: string;
	}): Record<string, unknown> {
		return this.pipelineManager.advanceIssuerLifecycle(opts);
	}

	advanceFastWorkerLifecycle(opts: {
		taskId?: string;
		action?: string;
		message?: string;
		reason?: string;
		agentId?: string;
	}): Record<string, unknown> {
		return this.pipelineManager.advanceFastWorkerLifecycle(opts);
	}

	advanceFinisherLifecycle(opts: {
		taskId?: string;
		action?: string;
		message?: string;
		reason?: string;
		agentId?: string;
	}): Record<string, unknown> {
		return this.pipelineManager.advanceFinisherLifecycle(opts);
	}

	async #restoreMergerQueueFromReplicas(): Promise<void> {
		if (this.#mergerQueueRestored) {
			void this.#processMergerQueue();
			return;
		}

		this.#mergerQueueRestored = true;
		if (!this.config.enableReplicas || !this.#replicaManager) return;

		try {
			const replicaTaskIds = await this.#replicaManager.listReplicas();
			let restoredCount = 0;
			for (const replicaTaskId of replicaTaskIds) {
				try {
					const task = await this.tasksClient.show(replicaTaskId);
					if (task.status !== "in_progress") {
						try {
							await this.#replicaManager.destroyReplica(replicaTaskId);
							this.loopLog(
								`Removed stale replica ${replicaTaskId} during startup restore (status: ${task.status})`,
								"debug",
								{ taskId: replicaTaskId },
							);
						} catch (destroyErr) {
							this.loopLog(
								`Failed to clean stale replica ${replicaTaskId} during startup restore: ${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`,
								"debug",
								{ taskId: replicaTaskId },
							);
						}
						continue;
					}

					if (this.#mergerQueue.hasTask(task.id)) continue;
					const replicaDir = this.#replicaManager.getReplicaDir(task.id);
					if (!this.#mergerQueue.enqueue(task.id, replicaDir)) continue;
					restoredCount += 1;
				} catch (err) {
					this.loopLog(
						`Skipped replica ${replicaTaskId} during merger queue restore: ${err instanceof Error ? err.message : String(err)}`,
						"debug",
						{ replicaTaskId },
					);
					try {
						await this.#replicaManager.destroyReplica(replicaTaskId);
						this.loopLog(`Removed orphaned replica ${replicaTaskId} during startup restore`, "debug", {
							taskId: replicaTaskId,
						});
					} catch (destroyErr) {
						this.loopLog(
							`Failed to remove orphaned replica ${replicaTaskId} during startup restore: ${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`,
							"debug",
							{ taskId: replicaTaskId },
						);
					}
				}
			}

			if (restoredCount > 0) {
				this.loopLog(`Restored ${restoredCount} queued merger task(s) from replica directories`, "info", {
					restoredCount,
					queueSize: this.#mergerQueue.size(),
				});
			}
		} catch (err) {
			this.loopLog(
				`Failed to restore merger queue from replica directories: ${err instanceof Error ? err.message : String(err)}`,
				"warn",
			);
		}

		void this.#processMergerQueue();
	}

	async #closeTaskAndUnblockDependents(taskId: string, reason: string): Promise<boolean> {
		let taskClosed = false;
		try {
			await this.tasksClient.close(taskId, reason);
			taskClosed = true;
		} catch (err) {
			this.loopLog(`Failed to close task ${taskId}: ${err instanceof Error ? err.message : String(err)}`, "warn", {
				taskId,
				reason,
			});
		}

		if (!taskClosed || this.paused) return taskClosed;

		try {
			const unblockedDependents = await this.scheduler.findTasksUnblockedBy(taskId);
			let autoSpawnedCount = 0;
			let skippedNoSlotCount = 0;
			let skippedInFlightCount = 0;
			let unblockedCount = 0;
			let unblockFailedCount = 0;
			let availableSlots = this.pipelineManager.availableWorkerSlots();
			for (const dependent of unblockedDependents) {
				if (dependent.status !== "blocked") continue;
				try {
					await this.tasksClient.updateStatus(dependent.id, "open");
					unblockedCount += 1;
				} catch (err) {
					unblockFailedCount += 1;
					this.loopLog(
						`Failed to unblock dependent task ${dependent.id} after close ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
						"warn",
						{ taskId, dependentTaskId: dependent.id },
					);
				}
			}

			for (const dependent of unblockedDependents) {
				if (availableSlots <= 0) {
					skippedNoSlotCount = unblockedDependents.length - autoSpawnedCount - skippedInFlightCount;
					break;
				}
				if (this.pipelineManager.isPipelineInFlight(dependent.id)) {
					skippedInFlightCount += 1;
					continue;
				}
				this.pipelineManager.kickoffNewTaskPipeline(dependent);
				autoSpawnedCount += 1;
				availableSlots -= 1;
			}
			const skippedCount = skippedInFlightCount + skippedNoSlotCount;
			if (autoSpawnedCount > 0 || skippedCount > 0) {
				this.loopLog(`Auto-spawned ${autoSpawnedCount} dependent issuer(s) after task close ${taskId}`, "info", {
					closedTaskId: taskId,
					autoSpawnedCount,
					skippedInFlightCount,
					skippedNoSlotCount,
					skippedCount,
					unblockedCount,
					unblockFailedCount,
					unblockedDependentCount: unblockedDependents.length,
					unblockedDependentIds: unblockedDependents.map(task => task.id),
				});
			}
		} catch (err) {
			this.loopLog(
				`Failed to auto-spawn dependents after close for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
				"warn",
				{ taskId },
			);
		}

		return taskClosed;
	}

	async #isTaskReadyForMergeQueue(taskId: string): Promise<boolean> {
		const task = await this.tasksClient.show(taskId);
		return task.status === "in_progress";
	}

	#abortActiveAgentsByRole(taskId: string, role: AgentInfo["role"]): number {
		const agents = this.registry.getActiveByTask(taskId).filter(agent => agent.role === role);
		for (const agent of agents) {
			const rpc = agent.rpc;
			if (rpc && rpc instanceof OmsRpcClient) {
				void rpc.abort().catch(err => {
					this.loopLog(`Failed to abort ${role} RPC during close (non-fatal)`, "debug", {
						taskId,
						role,
						agentId: agent.id,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}
		return agents.length;
	}

	async #processMergerQueue(): Promise<void> {
		if (this.#mergerQueueRunning) return;
		this.#mergerQueueRunning = true;
		try {
			if (!this.running || this.paused) return;
			if (!this.config.enableReplicas || !this.#replicaManager) return;
			if (this.#mergerQueueProcessing) {
				const activeMergerExists = this.registry.getActive().some(agent => agent.role === "merger");
				if (activeMergerExists) return;
				this.#mergerQueueProcessing = false;
				this.loopLog("Merger queue lock reset after merger agent exit without completion signal", "warn");
			}
			while (true) {
				const entry = this.#mergerQueue.peek();
				if (!entry) return;
				let hasMergeWork = true;
				try {
					hasMergeWork = await this.#isTaskReadyForMergeQueue(entry.taskId);
				} catch (err) {
					this.loopLog(
						`Failed to check queued task status for ${entry.taskId}: ${err instanceof Error ? err.message : String(err)}`,
						"warn",
						{ taskId: entry.taskId },
					);
					hasMergeWork = true;
				}
				if (!hasMergeWork) {
					this.#mergerQueue.dequeue();
					try {
						await this.#replicaManager.destroyReplica(entry.taskId);
					} catch (err) {
						this.loopLog(
							`Failed to cleanup stale merge queue entry for ${entry.taskId}: ${err instanceof Error ? err.message : String(err)}`,
							"warn",
							{ taskId: entry.taskId },
						);
					}
					this.loopLog(`Skipped merger for ${entry.taskId}: task no longer in_progress`, "warn", {
						taskId: entry.taskId,
						replicaDir: entry.replicaDir,
					});
					continue;
				}
				const replicaExists = await this.#replicaManager.replicaExists(entry.taskId).catch(err => {
					this.loopLog(
						`Failed to check queued replica for ${entry.taskId}: ${err instanceof Error ? err.message : String(err)}`,
						"warn",
						{
							taskId: entry.taskId,
							replicaDir: entry.replicaDir,
						},
					);
					return false;
				});
				if (!replicaExists) {
					this.#mergerQueue.dequeue();
					await this.#closeTaskAndUnblockDependents(
						entry.taskId,
						"Closed without merge (replica directory missing)",
					);
					this.loopLog(`Skipped merger for ${entry.taskId}: replica directory missing`, "warn", {
						taskId: entry.taskId,
						replicaDir: entry.replicaDir,
					});
					continue;
				}
				this.#mergerQueueProcessing = true;
				try {
					const merger = await this.spawner.spawnMerger(entry.taskId, entry.replicaDir);
					this.rpcHandlerManager.attachRpcHandlers(merger);
					this.lifecycleHelpers.logAgentStart("loop", merger, `Replica merge: ${entry.replicaDir}`);
					this.onDirty?.();
				} catch (err) {
					this.#mergerQueueProcessing = false;
					this.loopLog(
						`Failed to spawn merger for ${entry.taskId}: ${err instanceof Error ? err.message : String(err)}`,
						"warn",
						{
							taskId: entry.taskId,
							replicaDir: entry.replicaDir,
						},
					);
				}
				return;
			}
		} finally {
			this.#mergerQueueRunning = false;
		}
	}
	async handleFinisherCloseTask(opts: {
		taskId?: string;
		reason?: string;
		agentId?: string;
	}): Promise<Record<string, unknown>> {
		const taskId = typeof opts.taskId === "string" ? opts.taskId.trim() : "";
		if (!taskId) {
			return { ok: false, summary: "finisher_close_task rejected: taskId is required" };
		}

		const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
		const agentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
		this.pipelineManager.recordFinisherClose?.({
			taskId,
			reason: reason || undefined,
			agentId: agentId || undefined,
		});

		const finishers = this.registry.getActiveByTask(taskId).filter(agent => agent.role === "finisher");
		const finisherWithReplica =
			finishers.find(
				agent => agent.id === agentId && typeof agent.replicaDir === "string" && agent.replicaDir.trim(),
			) ?? finishers.find(agent => typeof agent.replicaDir === "string" && agent.replicaDir.trim());
		const replicaDir =
			typeof finisherWithReplica?.replicaDir === "string" ? finisherWithReplica.replicaDir.trim() : "";

		if (this.config.enableReplicas && this.#replicaManager && replicaDir) {
			let replicaExists = false;
			try {
				replicaExists = await this.#replicaManager.replicaExists(taskId);
			} catch (err) {
				this.loopLog(
					`Failed to check replica existence for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
					"warn",
					{ taskId, replicaDir },
				);
			}

			if (replicaExists) {
				this.#mergerQueue.enqueue(taskId, replicaDir);
				const abortedFinisherCount = this.#abortActiveAgentsByRole(taskId, "finisher");
				this.loopLog(`Finisher close queued merger for ${taskId}`, "info", {
					taskId,
					reason: reason || null,
					agentId: agentId || null,
					replicaDir,
					abortedFinisherCount,
					mergerQueueSize: this.#mergerQueue.size(),
				});
				void this.#processMergerQueue();
				return {
					ok: true,
					summary: `finisher_close_task queued merger for ${taskId}`,
					taskId,
					reason: reason || null,
					agentId: agentId || null,
					replicaDir,
					queuedForMerge: true,
					abortedFinisherCount,
				};
			}
		}

		await this.#closeTaskAndUnblockDependents(taskId, reason || "Closed by finisher");
		const abortedFinisherCount = this.#abortActiveAgentsByRole(taskId, "finisher");
		this.loopLog(`Finisher close recorded for ${taskId}`, "info", {
			taskId,
			reason: reason || null,
			agentId: agentId || null,
			abortedFinisherCount,
		});

		return {
			ok: true,
			summary: `finisher_close_task recorded for ${taskId}`,
			taskId,
			reason: reason || null,
			agentId: agentId || null,
			abortedFinisherCount,
		};
	}

	async handleExternalTaskClose(taskId: string): Promise<void> {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId || !this.#mergerQueue.hasTask(normalizedTaskId)) return;

		this.#mergerQueue.remove(normalizedTaskId);
		if (this.#replicaManager) {
			try {
				await this.#replicaManager.destroyReplica(normalizedTaskId);
			} catch (err) {
				this.loopLog(
					`Failed to destroy replica for externally closed task ${normalizedTaskId}: ${err instanceof Error ? err.message : String(err)}`,
					"warn",
					{ taskId: normalizedTaskId },
				);
			}
		}

		const abortedMergerCount = this.#abortActiveAgentsByRole(normalizedTaskId, "merger");
		this.loopLog(`External close removed ${normalizedTaskId} from merger queue`, "info", {
			taskId: normalizedTaskId,
			abortedMergerCount,
			mergerQueueSize: this.#mergerQueue.size(),
		});
		void this.#processMergerQueue();
	}

	async handleMergerComplete(opts: {
		taskId?: string;
		reason?: string;
		agentId?: string;
	}): Promise<Record<string, unknown>> {
		const taskId = typeof opts.taskId === "string" ? opts.taskId.trim() : "";
		if (!taskId) {
			return { ok: false, summary: "merger_complete rejected: taskId is required" };
		}

		const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
		const agentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
		const queueHead = this.#mergerQueue.peek();
		if (queueHead?.taskId === taskId) {
			this.#mergerQueue.dequeue();
		} else {
			this.#mergerQueue.remove(taskId);
		}

		if (this.#replicaManager) {
			try {
				await this.#replicaManager.destroyReplica(taskId);
			} catch (err) {
				this.loopLog(
					`Failed to destroy replica for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
					"warn",
					{ taskId },
				);
			}
		}

		await this.#closeTaskAndUnblockDependents(taskId, reason || "Closed by merger");
		const abortedMergerCount = this.#abortActiveAgentsByRole(taskId, "merger");

		this.#mergerQueueProcessing = false;
		void this.#processMergerQueue();

		this.loopLog(`Merger complete recorded for ${taskId}`, "info", {
			taskId,
			reason: reason || null,
			agentId: agentId || null,
			abortedMergerCount,
		});

		return {
			ok: true,
			summary: `merger_complete recorded for ${taskId}`,
			taskId,
			reason: reason || null,
			agentId: agentId || null,
			abortedMergerCount,
		};
	}

	async handleMergerConflict(opts: {
		taskId?: string;
		reason?: string;
		agentId?: string;
	}): Promise<Record<string, unknown>> {
		const taskId = typeof opts.taskId === "string" ? opts.taskId.trim() : "";
		if (!taskId) {
			return { ok: false, summary: "merger_conflict rejected: taskId is required" };
		}

		const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
		const conflictReason = reason || "No conflict details provided";
		const agentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
		const queueHead = this.#mergerQueue.peek();
		if (queueHead?.taskId === taskId) {
			this.#mergerQueue.dequeue();
		} else {
			this.#mergerQueue.remove(taskId);
		}

		try {
			await this.tasksClient.updateStatus(taskId, "blocked");
		} catch (err) {
			this.loopLog(
				`Failed to set blocked status for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
				"warn",
				{ taskId },
			);
		}

		try {
			await this.tasksClient.comment(taskId, `Blocked by merger conflict. ${conflictReason}`);
		} catch (err) {
			logger.debug("loop/agent-loop.ts: failed to post merger conflict comment (non-fatal)", { err });
		}

		const abortedMergerCount = this.#abortActiveAgentsByRole(taskId, "merger");

		this.#mergerQueueProcessing = false;
		void this.#processMergerQueue();

		this.loopLog(`Merger conflict recorded for ${taskId}`, "warn", {
			taskId,
			reason: conflictReason,
			agentId: agentId || null,
			abortedMergerCount,
		});

		return {
			ok: true,
			summary: `merger_conflict recorded for ${taskId}`,
			taskId,
			reason: conflictReason,
			agentId: agentId || null,
			abortedMergerCount,
		};
	}

	async steerAgent(taskId: string, message: string): Promise<boolean> {
		if (!this.running) return false;
		return await this.steeringManager.steerAgent(taskId, message);
	}

	async interruptAgent(taskId: string, message: string): Promise<boolean> {
		if (!this.running) return false;
		return await this.steeringManager.interruptAgent(taskId, message);
	}

	async complain(opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
		files: string[];
		reason: string;
	}): Promise<Record<string, unknown>> {
		return await this.complaintManager.complain(opts);
	}

	async revokeComplaint(opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
		files?: string[];
		cause?: string;
	}): Promise<Record<string, unknown>> {
		return await this.complaintManager.revokeComplaint(opts);
	}

	async waitForAgent(
		agentId: string,
		opts?: { timeoutMs?: number; pollMs?: number },
	): Promise<Record<string, unknown>> {
		const normalizedAgentId = agentId.trim();
		if (!normalizedAgentId) {
			return { ok: false, summary: "wait_for_agent rejected: agentId is required" };
		}

		const pollMs = Math.max(100, Math.trunc(opts?.pollMs ?? 500));
		const timeoutMs = Math.max(0, Math.trunc(opts?.timeoutMs ?? 0));
		const startedAt = Date.now();

		while (true) {
			const agent = this.registry.get(normalizedAgentId);
			if (!agent) {
				return {
					ok: false,
					summary: `Agent not found: ${normalizedAgentId}`,
					agentId: normalizedAgentId,
					status: "not_found",
				};
			}

			if (isTerminalStatus(agent.status)) {
				return {
					ok: true,
					summary: `Agent ${normalizedAgentId} exited with status ${agent.status}`,
					agentId: normalizedAgentId,
					status: agent.status,
					lastActivity: agent.lastActivity,
				};
			}

			if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
				return {
					ok: false,
					summary: `Timeout waiting for agent ${normalizedAgentId}`,
					agentId: normalizedAgentId,
					status: agent.status,
					timeoutMs,
				};
			}

			await Bun.sleep(pollMs);
		}
	}

	async spawnAgentBySingularity(opts: {
		role: "finisher" | "issuer" | "worker";
		taskId: string;
		context?: string;
	}): Promise<void> {
		if (!this.running) return;
		if (this.paused) return;
		const { role, taskId, context } = opts;
		const ctx = context?.trim() || "";
		const key = `${role}:${taskId}`;
		if (this.spawnAgentInFlight.has(key)) {
			this.loopLog(`replace_agent: already in-flight for ${key}, skipping`, "warn");
			return;
		}
		this.spawnAgentInFlight.add(key);
		this.pipelineManager.addPipelineInFlight(taskId);
		this.loopLog(`Singularity requested spawn: ${role} for ${taskId}`, "info", {
			role,
			taskId,
			context: ctx || undefined,
		});

		// Unblock the task if it's blocked — replace_agent is used to recover stuck tasks.
		try {
			const task = await this.tasksClient.show(taskId);
			if (task.status === "blocked") {
				await this.tasksClient.updateStatus(taskId, "in_progress");
				this.loopLog(`replace_agent: unblocked task ${taskId}`, "info", { taskId });
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.loopLog(`replace_agent: failed to check/unblock task ${taskId}: ${message}`, "warn", { taskId });
			throw new Error(`replace_agent: failed to check/unblock task ${taskId}: ${message}`);
		}

		// Duplicate detection: if any active agent exists for this task,
		// stop all of them first, then spawn a fresh replacement.
		const existingForTask = this.registry.getActiveByTask(taskId);

		if (existingForTask.length > 0) {
			await this.stopAgentsMatching(agent => agent.taskId === taskId);
			this.loopLog(`replace_agent: stopped existing agent(s) for ${taskId} before spawning fresh ${role}`, "info", {
				role,
				taskId,
				replacedAgentIds: existingForTask.map(agent => agent.id),
			});
		}

		try {
			if (role === "finisher") {
				const workerOutput = ctx || "[Spawned by singularity for lifecycle recovery]";
				const finisher = await this.steeringManager.spawnFinisherAfterStoppingSteering(taskId, workerOutput);
				this.rpcHandlerManager.attachRpcHandlers(finisher);
				this.lifecycleHelpers.logAgentStart("singularity", finisher, ctx);
			} else if (role === "issuer") {
				const task = await this.tasksClient.show(taskId);
				const result = await this.pipelineManager.runIssuerForTask(task, { kickoffMessage: ctx || undefined });
				if (result.skip) {
					const skipReason = result.reason || result.message || "No implementation work needed";
					const finisherInput =
						`[Issuer skip — no worker spawned]\n\n` +
						`The issuer determined no implementation work is needed for this task.\n` +
						`Reason: ${skipReason}`;
					this.loopLog(`Singularity issuer skipped worker for ${taskId}: ${skipReason}`, "info", {
						taskId,
						reason: skipReason,
					});

					try {
						const finisher = await this.steeringManager.spawnFinisherAfterStoppingSteering(taskId, finisherInput);
						this.rpcHandlerManager.attachRpcHandlers(finisher);
						this.lifecycleHelpers.logAgentStart("singularity", finisher, `skip: ${skipReason}`);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						this.loopLog(`Finisher spawn failed (skip) for ${taskId}: ${msg}`, "warn", {
							taskId,
							error: msg,
						});
					}
				} else if (!result.start) {
					const reason = result.reason || "Issuer deferred start";
					this.loopLog(`Singularity issuer deferred ${taskId}: ${reason}`, "warn", {
						taskId,
						reason,
					});

					try {
						await this.tasksClient.updateStatus(taskId, "blocked");
					} catch (err) {
						this.loopLog(
							`Failed to set blocked status for ${taskId}: ${err instanceof Error ? err.message : err}`,
							"warn",
							{ taskId },
						);
					}

					try {
						await this.tasksClient.comment(
							taskId,
							`Blocked by issuer (singularity spawn). ${reason}${result.message ? `\nmessage: ${result.message}` : ""}`,
						);
					} catch (err) {
						logger.debug(
							"loop/agent-loop.ts: failed to post blocked-task comment after spawn failure (non-fatal)",
							{ err },
						);
					}
				} else {
					const kickoff = result.message ?? null;
					const task2 = await this.tasksClient.show(taskId);
					const worker = await this.pipelineManager.spawnTaskWorker(task2, {
						claim: true,
						kickoffMessage: kickoff,
					});
					this.lifecycleHelpers.logAgentStart("singularity", worker, kickoff ?? task2.title);
				}
			} else if (role === "worker") {
				const task = await this.tasksClient.show(taskId);
				const worker = await this.pipelineManager.spawnTaskWorker(task, {
					claim: true,
					kickoffMessage: ctx || undefined,
				});
				this.lifecycleHelpers.logAgentStart("singularity", worker, ctx);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.loopLog(`replace_agent failed: ${role} for ${taskId}: ${message}`, "warn", {
				taskId,
				role,
				error: message,
			});
			throw err;
		} finally {
			this.spawnAgentInFlight.delete(key);
			this.pipelineManager.removePipelineInFlight(taskId);
		}
		this.onDirty?.();
	}

	async stopAllAgentsAndPause(): Promise<void> {
		await this.pause();
		await this.stopAgentsMatching(agent => !!agent.taskId);
	}

	async stopAgentById(agentId: string): Promise<void> {
		if (!agentId.trim()) return;
		await this.stopAgentsMatching(agent => agent.id === agentId);
	}

	/** Stop active task agents (excluding finishers by default) without pausing the loop. */
	async stopAgentsForTask(taskId: string, opts?: { includeFinisher?: boolean }): Promise<void> {
		const includeFinisher = opts?.includeFinisher === true;
		const stopped = await this.stopAgentsMatching(
			agent => agent.taskId === taskId && (includeFinisher || agent.role !== "finisher"),
		);
		if (stopped.size > 0) {
			const reason = "Blocked by user via Stop. Ask Singularity for guidance, then unblock when ready.";
			await Promise.all(
				[...stopped].map(async stoppedTaskId => {
					try {
						await this.tasksClient.updateStatus(stoppedTaskId, "blocked");
					} catch (err) {
						this.loopLog(
							`Failed to set blocked status for ${stoppedTaskId}: ${err instanceof Error ? err.message : err}`,
							"warn",
							{ taskId: stoppedTaskId },
						);
					}

					try {
						await this.tasksClient.comment(stoppedTaskId, reason);
					} catch (err) {
						logger.debug(
							"loop/agent-loop.ts: best-effort failure after await this.tasksClient.comment(stoppedTaskId, reason);",
							{ err },
						);
					}
				}),
			);
			this.loopLog(`Stopped agents for task ${taskId}`, "info", { taskId, includeFinisher, stopped: [...stopped] });
			this.loopLog(`Blocked ${stopped.size} task(s) after Stop`, "info", { taskIds: [...stopped] });
		}
	}

	async stopAgentsForTaskIdsAndPause(
		taskIds: ReadonlySet<string>,
		opts?: { blockStoppedTasks?: boolean; blockReason?: string },
	): Promise<void> {
		await this.pause();
		const stoppedTaskIds = await this.stopAgentsMatching(agent => !!agent.taskId && taskIds.has(agent.taskId));

		if (opts?.blockStoppedTasks && stoppedTaskIds.size > 0) {
			const reason =
				opts.blockReason?.trim() ||
				"Blocked by user via Stop. Ask Singularity for guidance, then unblock when ready.";

			await Promise.all(
				[...stoppedTaskIds].map(async taskId => {
					try {
						await this.tasksClient.updateStatus(taskId, "blocked");
					} catch (err) {
						this.loopLog(
							`Failed to set blocked status for ${taskId}: ${err instanceof Error ? err.message : err}`,
							"warn",
							{ taskId },
						);
					}

					try {
						await this.tasksClient.comment(taskId, reason);
					} catch (err) {
						logger.debug(
							"loop/agent-loop.ts: best-effort failure after await this.tasksClient.comment(taskId, reason);",
							{ err },
						);
					}
				}),
			);

			this.loopLog(`Blocked ${stoppedTaskIds.size} task(s) after Stop`, "info", {
				taskIds: [...stoppedTaskIds],
			});
		}
	}

	private async stopAgentsMatching(predicate: (agent: AgentInfo) => boolean): Promise<Set<string>> {
		const agents = this.registry.getActive().filter(predicate);
		const stoppedTaskIds = new Set<string>();

		await Promise.all(
			agents.map(async agent => {
				// Mark status early so onAgentEnd guard sees terminal state
				// before the fire-and-forget abort() triggers agent_end events.
				const current = this.registry.get(agent.id);
				if (current) current.status = "stopped";
				const rpc = agent.rpc;
				if (rpc && rpc instanceof OmsRpcClient) {
					void rpc.abort().catch(err => {
						this.loopLog("Failed to abort worker RPC during stop sweep (non-fatal)", "debug", {
							agentId: agent.id,
							error: err instanceof Error ? err.message : String(err),
						});
					});

					try {
						await rpc.stop();
					} catch (err) {
						logger.debug("loop/agent-loop.ts: best-effort failure after await rpc.stop();", { err });
					}
				}

				await this.rpcHandlerManager.finishAgent(agent, "stopped");

				if (agent.taskId) stoppedTaskIds.add(agent.taskId);

				this.steeringManager.onAgentStopped(agent.id);
			}),
		);

		this.onDirty?.();
		return stoppedTaskIds;
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		if (this.paused) return;
		if (this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			await this.#processMergerQueue();
			let slots = this.pipelineManager.availableWorkerSlots();

			// Phase 1a: Resume some in-progress tasks, but keep one slot available for new work.
			if (slots > 1 && !this.paused) {
				const resumeBudget = slots - 1;
				const resumeCandidates = await this.scheduler.getInProgressTasksWithoutAgent(resumeBudget);
				for (const task of resumeCandidates) {
					if (slots <= 1 || this.paused) break;
					if (this.pipelineManager.isPipelineInFlight(task.id) || this.isLifecycleTransitionInFlight(task.id)) {
						continue;
					}
					this.pipelineManager.kickoffResumePipeline(task);
					slots--;
				}
			}

			// Phase 2b: Use any leftover slots for additional resume pipelines.
			if (slots > 0 && !this.paused) {
				const resumeCandidates = await this.scheduler.getInProgressTasksWithoutAgent(slots);
				for (const task of resumeCandidates) {
					if (slots <= 0 || this.paused) break;
					if (this.pipelineManager.isPipelineInFlight(task.id) || this.isLifecycleTransitionInFlight(task.id)) {
						continue;
					}
					this.pipelineManager.kickoffResumePipeline(task);
					slots--;
				}
			}
			await this.steeringManager.maybeSteerWorkers(this.paused);
		} finally {
			this.tickInFlight = false;
		}
	}
}
