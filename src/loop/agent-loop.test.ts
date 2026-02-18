import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import { createEmptyAgentUsage } from "../agents/types";
import { DEFAULT_CONFIG } from "../config";
import type { TaskStoreClient } from "../tasks/client";
import { AgentLoop } from "./agent-loop";

function makeRpc(overrides: Record<string, unknown> = {}): OmsRpcClient {
	const rpc = Object.create(OmsRpcClient.prototype) as OmsRpcClient & Record<string, unknown>;
	Object.assign(rpc, {
		abort: async () => {},
		stop: async () => {},
		steer: async (_message: string) => {},
		...overrides,
	});
	return rpc;
}

function createLoopFixture() {
	const calls = {
		close: [] as Array<{ taskId: string; reason?: string }>,
		setAgentState: [] as Array<{ id: string; state: string }>,
		clearSlot: [] as Array<{ id: string; slot: string }>,
		updateStatus: [] as Array<{ taskId: string; status: string }>,
		comment: [] as Array<{ taskId: string; text: string }>,
	};
	const tasksClient = {
		close: async (taskId: string, reason?: string) => {
			calls.close.push({ taskId, reason });
		},
		updateStatus: async (taskId: string, status: string) => {
			calls.updateStatus.push({ taskId, status });
		},
		comment: async (taskId: string, text: string) => {
			calls.comment.push({ taskId, text });
		},
		setAgentState: async (id: string, state: string) => {
			calls.setAgentState.push({ id, state });
		},
		clearSlot: async (id: string, slot: string) => {
			calls.clearSlot.push({ id, slot });
		},
	} as unknown as TaskStoreClient;
	const registry = new AgentRegistry({ tasksClient });
	const scheduler = {
		getInProgressTasksWithoutAgent: async () => [],
		getNextTasks: async () => [],
		findTasksUnblockedBy: async () => [],
	} as never;
	const spawner = {} as never;
	const loop = new AgentLoop({
		tasksClient,
		registry,
		scheduler,
		spawner,
		config: { ...DEFAULT_CONFIG, pollIntervalMs: 50, steeringIntervalMs: 50 },
	});
	return { loop, registry, calls };
}

type ReplicaDependentTask = {
	id: string;
	status?: string;
	issue_type?: string;
	depends_on_ids?: string[];
};

function createLoopWithReplicasFixture() {
	const calls = {
		close: [] as Array<{ taskId: string; reason?: string }>,
		setAgentState: [] as Array<{ id: string; state: string }>,
		clearSlot: [] as Array<{ id: string; slot: string }>,
		updateStatus: [] as Array<{ taskId: string; status: string }>,
		comment: [] as Array<{ taskId: string; text: string }>,
		show: [] as string[],
		replicaExists: [] as string[],
		destroyReplica: [] as string[],
		listReplicas: 0,
		getReplicaDir: [] as string[],
		spawnMerger: [] as Array<{ taskId: string; replicaDir: string }>,
		abortMerger: [] as string[],
		attachRpcHandlers: [] as string[],
		logAgentStart: [] as Array<{ agentId: string; note?: string }>,
		sequence: [] as string[],
	};
	const replicaExistsByTaskId = new Map<string, boolean>();
	const replicaDirsByTaskId = new Map<string, string>();
	const taskStatusByTaskId = new Map<string, string>();
	const dependentsByTaskId = new Map<string, ReplicaDependentTask[]>();
	const showErrorsByTaskId = new Map<string, Error>();

	const tasksClient = {
		workingDir: "/repo",
		close: async (taskId: string, reason?: string) => {
			calls.sequence.push(`close:${taskId}`);
			calls.close.push({ taskId, reason });
		},
		updateStatus: async (taskId: string, status: string) => {
			calls.sequence.push(`updateStatus:${taskId}:${status}`);
			calls.updateStatus.push({ taskId, status });
		},
		comment: async (taskId: string, text: string) => {
			calls.sequence.push(`comment:${taskId}`);
			calls.comment.push({ taskId, text });
		},
		setAgentState: async (id: string, state: string) => {
			calls.setAgentState.push({ id, state });
		},
		clearSlot: async (id: string, slot: string) => {
			calls.clearSlot.push({ id, slot });
		},
		show: async (taskId: string) => {
			calls.sequence.push(`show:${taskId}`);
			calls.show.push(taskId);
			const showError = showErrorsByTaskId.get(taskId);
			if (showError) throw showError;
			return {
				id: taskId,
				title: `Task ${taskId}`,
				description: null,
				acceptance_criteria: null,
				status: taskStatusByTaskId.get(taskId) ?? "in_progress",
				priority: 2,
				issue_type: "task",
				labels: [],
				assignee: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
			};
		},
	} as unknown as TaskStoreClient;
	const registry = new AgentRegistry({ tasksClient });
	const scheduler = {
		getInProgressTasksWithoutAgent: async () => [],
		getNextTasks: async () => [],
		findTasksUnblockedBy: async (taskId: string) => dependentsByTaskId.get(taskId) ?? [],
	} as never;

	const replicaManager = {
		replicaExists: async (taskId: string) => {
			calls.sequence.push(`replicaExists:${taskId}`);
			calls.replicaExists.push(taskId);
			return replicaExistsByTaskId.get(taskId) ?? false;
		},
		destroyReplica: async (taskId: string) => {
			calls.sequence.push(`destroyReplica:${taskId}`);
			calls.destroyReplica.push(taskId);
		},
		listReplicas: async () => {
			calls.sequence.push("listReplicas");
			calls.listReplicas += 1;
			return [...replicaDirsByTaskId.keys()];
		},
		getReplicaDir: (taskId: string) => {
			calls.sequence.push(`getReplicaDir:${taskId}`);
			calls.getReplicaDir.push(taskId);
			return replicaDirsByTaskId.get(taskId) ?? `/tmp/replica/${taskId}`;
		},
	};

	let mergerCount = 0;
	const spawner = {
		getReplicaManager: () => replicaManager,
		spawnMerger: async (taskId: string, replicaDir: string) => {
			calls.sequence.push(`spawnMerger:${taskId}`);
			calls.spawnMerger.push({ taskId, replicaDir });
			mergerCount += 1;
			return registry.register({
				id: `merger:${taskId}:${mergerCount}`,
				role: "merger",
				taskId,
				tasksAgentId: `agent-merger-${mergerCount}`,
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: mergerCount,
				lastActivity: mergerCount + 1,
				rpc: makeRpc({ abort: async () => calls.abortMerger.push(taskId) }),
			});
		},
	} as never;

	const loop = new AgentLoop({
		tasksClient,
		registry,
		scheduler,
		spawner,
		config: { ...DEFAULT_CONFIG, enableReplicas: true, pollIntervalMs: 50, steeringIntervalMs: 50 },
	});
	(
		loop as unknown as {
			rpcHandlerManager: { attachRpcHandlers: (agent: { id: string }) => void };
		}
	).rpcHandlerManager.attachRpcHandlers = (agent: { id: string }) => {
		calls.sequence.push(`attachRpcHandlers:${agent.id}`);
		calls.attachRpcHandlers.push(agent.id);
	};
	(
		loop as unknown as {
			lifecycleHelpers: {
				logAgentStart: (_startedBy: string, agent: { id: string }, note?: string) => void;
			};
		}
	).lifecycleHelpers.logAgentStart = (_startedBy: string, agent: { id: string }, note?: string) => {
		calls.sequence.push(`logAgentStart:${agent.id}`);
		calls.logAgentStart.push({ agentId: agent.id, note });
	};

	const setReplica = (taskId: string, replicaDir: string, exists = true): void => {
		replicaDirsByTaskId.set(taskId, replicaDir);
		replicaExistsByTaskId.set(taskId, exists);
	};
	const setReplicaExists = (taskId: string, exists: boolean): void => {
		replicaExistsByTaskId.set(taskId, exists);
	};
	const setTaskStatus = (taskId: string, status: string): void => {
		taskStatusByTaskId.set(taskId, status);
	};
	const setShowError = (taskId: string, error: Error): void => {
		showErrorsByTaskId.set(taskId, error);
	};
	const setUnblockedDependents = (taskId: string, dependents: ReplicaDependentTask[]): void => {
		dependentsByTaskId.set(taskId, dependents);
	};

	return {
		loop,
		registry,
		calls,
		setReplica,
		setReplicaExists,
		setTaskStatus,
		setUnblockedDependents,
		setShowError,
	};
}

function registerReplicaFinisher(
	fixture: ReturnType<typeof createLoopWithReplicasFixture>,
	opts: { taskId: string; agentId: string; replicaDir?: string; onAbort?: () => void },
): void {
	fixture.registry.register({
		id: opts.agentId,
		role: "finisher",
		taskId: opts.taskId,
		tasksAgentId: `agent-${opts.agentId}`,
		status: "running",
		usage: createEmptyAgentUsage(),
		events: [],
		spawnedAt: 1,
		lastActivity: 2,
		replicaDir: opts.replicaDir,
		rpc: makeRpc({ abort: async () => opts.onAbort?.() }),
	});
}

describe("AgentLoop lifecycle", () => {
	test("start -> pause -> resume -> stop transitions", async () => {
		const { loop, registry } = createLoopFixture();
		let heartbeatStarts = 0;
		let heartbeatStops = 0;
		registry.startHeartbeat = () => {
			heartbeatStarts += 1;
		};
		registry.stopHeartbeat = async () => {
			heartbeatStops += 1;
		};

		expect(loop.isRunning()).toBe(false);
		loop.start();
		expect(loop.isRunning()).toBe(true);
		expect(loop.isPaused()).toBe(false);

		await loop.pause();
		expect(loop.isPaused()).toBe(true);

		loop.resume();
		expect(loop.isPaused()).toBe(false);

		await loop.stop();
		expect(loop.isRunning()).toBe(false);
		expect(loop.isPaused()).toBe(false);
		expect(heartbeatStarts).toBeGreaterThanOrEqual(2);
		expect(heartbeatStops).toBeGreaterThanOrEqual(2);
	});

	test("wake ignores stopped/paused loop and coalesces duplicate wake requests", async () => {
		const { loop } = createLoopFixture();
		let ticks = 0;
		(loop as unknown as { tick: () => Promise<void> }).tick = async () => {
			ticks += 1;
		};

		loop.wake();
		expect(ticks).toBe(0);

		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { running: boolean; paused: boolean }).paused = true;
		loop.wake();
		expect(ticks).toBe(0);

		(loop as unknown as { paused: boolean }).paused = false;
		loop.wake();
		loop.wake();
		await Bun.sleep(5);
		expect(ticks).toBe(1);
	});
});

describe("AgentLoop delegation", () => {
	test("advanceIssuerLifecycle delegates to pipeline manager", () => {
		const { loop } = createLoopFixture();
		const delegated: unknown[] = [];
		(loop as unknown as { pipelineManager: { advanceIssuerLifecycle: (opts: unknown) => unknown } }).pipelineManager =
			{
				advanceIssuerLifecycle: (opts: unknown) => {
					delegated.push(opts);
					return { ok: true, source: "pipeline" };
				},
			};

		const result = loop.advanceIssuerLifecycle({ taskId: "task-1", action: "promote" });
		expect(result).toEqual({ ok: true, source: "pipeline" });
		expect(delegated).toEqual([{ taskId: "task-1", action: "promote" }]);
	});

	test("advanceFastWorkerLifecycle delegates to pipeline manager", () => {
		const { loop } = createLoopFixture();
		const delegated: unknown[] = [];
		(
			loop as unknown as {
				pipelineManager: {
					advanceFastWorkerLifecycle: (opts: unknown) => unknown;
				};
			}
		).pipelineManager = {
			advanceFastWorkerLifecycle: (opts: unknown) => {
				delegated.push(opts);
				return { ok: true, source: "pipeline-fast-worker" };
			},
		} as never;

		const result = loop.advanceFastWorkerLifecycle({ taskId: "task-1", action: "done" });
		expect(result).toEqual({ ok: true, source: "pipeline-fast-worker" });
		expect(delegated).toEqual([{ taskId: "task-1", action: "done" }]);
	});

	test("advanceFinisherLifecycle delegates to pipeline manager", () => {
		const { loop } = createLoopFixture();
		const delegated: unknown[] = [];
		(
			loop as unknown as {
				pipelineManager: {
					advanceFinisherLifecycle: (opts: unknown) => unknown;
				};
			}
		).pipelineManager = {
			advanceFinisherLifecycle: (opts: unknown) => {
				delegated.push(opts);
				return { ok: true, source: "pipeline-finisher" };
			},
		} as never;

		const result = loop.advanceFinisherLifecycle({ taskId: "task-1", action: "worker" });
		expect(result).toEqual({ ok: true, source: "pipeline-finisher" });
		expect(delegated).toEqual([{ taskId: "task-1", action: "worker" }]);
	});

	test("spawnAgentBySingularity replaces worker by stopping all active roles on the task first", async () => {
		const { loop, registry } = createLoopFixture();
		(loop as unknown as { running: boolean }).running = true;
		const eventOrder: string[] = [];
		const abortCalls: string[] = [];
		const stopCalls: string[] = [];
		const staleAgentIds = [
			"worker:task-1:old",
			"issuer:task-1:old",
			"finisher:task-1:old",
			"steering:task-1:old",
		] as const;

		const registerTaskAgent = (id: string, role: "worker" | "issuer" | "finisher" | "steering"): void => {
			registry.register({
				id,
				role,
				taskId: "task-1",
				tasksAgentId: `agent-${id}`,
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: 1,
				lastActivity: 2,
				rpc: makeRpc({
					abort: async () => {
						abortCalls.push(id);
						eventOrder.push(`abort:${id}`);
					},
					stop: async () => {
						stopCalls.push(id);
						eventOrder.push(`stop:${id}`);
					},
				}),
			});
		};

		registerTaskAgent(staleAgentIds[0], "worker");
		registerTaskAgent(staleAgentIds[1], "issuer");
		registerTaskAgent(staleAgentIds[2], "finisher");
		registerTaskAgent(staleAgentIds[3], "steering");

		(
			loop as unknown as {
				tasksClient: {
					show: (taskId: string) => Promise<{ id: string; title: string; status: string; issue_type: string }>;
				};
			}
		).tasksClient.show = async (taskId: string) => ({
			id: taskId,
			title: "Task 1",
			status: "in_progress",
			issue_type: "task",
		});

		const replacementWorkerId = "worker:task-1:new";
		(
			loop as unknown as {
				pipelineManager: {
					spawnTaskWorker: (
						task: { id: string },
						opts?: { claim?: boolean; kickoffMessage?: string | null },
					) => Promise<unknown>;
				};
			}
		).pipelineManager.spawnTaskWorker = async (task: { id: string }) => {
			eventOrder.push(`spawn:${replacementWorkerId}`);
			return registry.register({
				id: replacementWorkerId,
				role: "worker",
				taskId: task.id,
				tasksAgentId: "agent-worker-new",
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: 3,
				lastActivity: 4,
				rpc: makeRpc(),
			});
		};

		await loop.spawnAgentBySingularity({ role: "worker", taskId: "task-1" });

		expect([...abortCalls].sort()).toEqual([...staleAgentIds].sort());
		for (const agentId of staleAgentIds) {
			expect(stopCalls).toContain(agentId);
			expect(registry.get(agentId)?.status).toBe("stopped");
		}

		const spawnIndex = eventOrder.indexOf(`spawn:${replacementWorkerId}`);
		expect(spawnIndex).toBeGreaterThan(-1);
		for (const agentId of staleAgentIds) {
			expect(eventOrder.lastIndexOf(`stop:${agentId}`)).toBeLessThan(spawnIndex);
		}

		const activeAgentIds = registry.getActiveByTask("task-1").map(agent => agent.id);
		expect(activeAgentIds).toEqual([replacementWorkerId]);
	});

	test("spawnAgentBySingularity does not launch issuer while paused", async () => {
		const { loop } = createLoopFixture();
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { running: boolean; paused: boolean }).paused = true;
		let showCalls = 0;
		let runIssuerCalls = 0;

		(
			loop as unknown as {
				tasksClient: {
					show: (taskId: string) => Promise<{ id: string; title: string; status: string; issue_type: string }>;
				};
			}
		).tasksClient.show = async (taskId: string) => {
			showCalls += 1;
			return {
				id: taskId,
				title: "Task 1",
				status: "open",
				issue_type: "task",
			};
		};

		(
			loop as unknown as {
				pipelineManager: {
					runIssuerForTask: (_task: unknown, _opts?: { kickoffMessage?: string }) => Promise<unknown>;
				};
			}
		).pipelineManager.runIssuerForTask = async () => {
			runIssuerCalls += 1;
			return { start: false, reason: "paused test" };
		};

		await loop.spawnAgentBySingularity({ role: "issuer", taskId: "task-1" });

		expect(showCalls).toBe(0);
		expect(runIssuerCalls).toBe(0);
	});

	test("spawnAgentBySingularity keeps replace_agent unblock behavior for blocked tasks", async () => {
		const { loop, registry, calls } = createLoopFixture();
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		let spawnCalls = 0;

		(
			loop as unknown as {
				tasksClient: {
					show: (taskId: string) => Promise<{ id: string; title: string; status: string; issue_type: string }>;
				};
			}
		).tasksClient.show = async taskId => ({
			id: taskId,
			title: "Task 1",
			status: "blocked",
			issue_type: "task",
		});

		(
			loop as unknown as {
				pipelineManager: {
					spawnTaskWorker: (
						task: { id: string },
						opts?: { claim?: boolean; kickoffMessage?: string | null },
					) => Promise<unknown>;
				};
			}
		).pipelineManager.spawnTaskWorker = async (task: { id: string }) => {
			spawnCalls += 1;
			return registry.register({
				id: `worker:${task.id}:replacement`,
				role: "worker",
				taskId: task.id,
				tasksAgentId: `agent-worker-${task.id}-replacement`,
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: 1,
				lastActivity: 2,
				rpc: makeRpc(),
			});
		};

		await loop.spawnAgentBySingularity({ role: "worker", taskId: "task-1" });

		expect(calls.updateStatus).toContainEqual({ taskId: "task-1", status: "in_progress" });
		expect(spawnCalls).toBe(1);
	});

	test("stopAgentsForTask blocks task when active agents were stopped", async () => {
		const { loop, registry, calls } = createLoopFixture();
		registry.register({
			id: "worker:task-stop",
			role: "worker",
			taskId: "task-stop",
			tasksAgentId: "agent-worker-task-stop",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
			rpc: makeRpc(),
		});

		await loop.stopAgentsForTask("task-stop");

		expect(calls.updateStatus).toEqual([{ taskId: "task-stop", status: "blocked" }]);
		expect(calls.comment).toEqual([
			{
				taskId: "task-stop",
				text: "Blocked by user via Stop. Ask Singularity for guidance, then unblock when ready.",
			},
		]);
	});

	test("stopAgentsForTask does not block task when no agents were stopped", async () => {
		const { loop, calls } = createLoopFixture();

		await loop.stopAgentsForTask("task-missing");

		expect(calls.updateStatus).toEqual([]);
		expect(calls.comment).toEqual([]);
	});
	test("handleFinisherCloseTask validates task id, closes task, and aborts active finisher rpc", async () => {
		const { loop, registry, calls } = createLoopFixture();
		const abortCalls: string[] = [];
		registry.register({
			id: "finisher:task-1",
			role: "finisher",
			taskId: "task-1",
			tasksAgentId: "agent-finisher",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
			rpc: makeRpc({ abort: async () => abortCalls.push("finisher:task-1") }),
		});

		const invalid = await loop.handleFinisherCloseTask({ taskId: "   " });
		expect(invalid).toEqual({ ok: false, summary: "finisher_close_task rejected: taskId is required" });

		const result = (await loop.handleFinisherCloseTask({
			taskId: "task-1",
			reason: "all done",
			agentId: "fin-1",
		})) as { ok: boolean; abortedFinisherCount: number };
		expect(result.ok).toBe(true);
		expect(result.abortedFinisherCount).toBe(1);
		expect(calls.close).toEqual([{ taskId: "task-1", reason: "all done" }]);
		expect(abortCalls).toEqual(["finisher:task-1"]);
	});

	test("handleFinisherCloseTask closes task but skips dependent auto-spawn while paused", async () => {
		const { loop, registry, calls } = createLoopFixture();
		(loop as unknown as { paused: boolean }).paused = true;
		const spawned: string[] = [];
		const findCalls: string[] = [];
		const abortCalls: string[] = [];

		registry.register({
			id: "finisher:task-a",
			role: "finisher",
			taskId: "task-a",
			tasksAgentId: "agent-finisher-task-a",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
			rpc: makeRpc({ abort: async () => abortCalls.push("finisher:task-a") }),
		});

		(
			loop as unknown as {
				scheduler: {
					findTasksUnblockedBy: (taskId: string) => Promise<unknown[]>;
					getInProgressTasksWithoutAgent: () => Promise<unknown[]>;
					getNextTasks: () => Promise<unknown[]>;
				};
			}
		).scheduler = {
			findTasksUnblockedBy: async (taskId: string) => {
				findCalls.push(taskId);
				return [{ id: "task-b", issue_type: "task", depends_on_ids: ["task-a"] }];
			},
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
		} as never;

		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 2,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: (task: { id: string }) => spawned.push(task.id),
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "done" });

		expect(calls.close).toEqual([{ taskId: "task-a", reason: "done" }]);
		expect(findCalls).toEqual([]);
		expect(spawned).toEqual([]);
		expect(abortCalls).toEqual(["finisher:task-a"]);
	});

	test("handleFinisherCloseTask auto-spawns dependents when dependencies are resolved", async () => {
		const { loop, calls } = createLoopFixture();
		const spawned: string[] = [];
		const findCalls: string[] = [];
		const dependent = { id: "task-b", issue_type: "task", depends_on_ids: ["task-a"] };

		(
			loop as unknown as {
				scheduler: {
					findTasksUnblockedBy: (taskId: string) => Promise<unknown[]>;
					getInProgressTasksWithoutAgent: () => Promise<unknown[]>;
					getNextTasks: () => Promise<unknown[]>;
				};
			}
		).scheduler = {
			findTasksUnblockedBy: async (taskId: string) => {
				findCalls.push(taskId);
				return [dependent];
			},
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
		} as never;

		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 2,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: (task: { id: string }) => spawned.push(task.id),
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "all done" });
		expect(findCalls).toEqual(["task-a"]);
		expect(calls.close).toEqual([{ taskId: "task-a", reason: "all done" }]);
		expect(spawned).toEqual(["task-b"]);
	});

	test("handleFinisherCloseTask does not auto-spawn when dependent task still waits on other dependencies", async () => {
		const { loop, calls } = createLoopFixture();
		const spawned: string[] = [];

		(
			loop as unknown as {
				scheduler: {
					findTasksUnblockedBy: (taskId: string) => Promise<unknown[]>;
					getInProgressTasksWithoutAgent: () => Promise<unknown[]>;
					getNextTasks: () => Promise<unknown[]>;
				};
			}
		).scheduler = {
			findTasksUnblockedBy: async () => [],
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
		} as never;

		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 2,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: (task: { id: string }) => spawned.push(task.id),
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "all done" });
		expect(calls.close).toEqual([{ taskId: "task-a", reason: "all done" }]);
		expect(spawned).toEqual([]);
	});

	test("handleFinisherCloseTask respects available slot limits when auto-spawning dependents", async () => {
		const { loop, calls } = createLoopFixture();
		const spawned: string[] = [];
		const dependents = [
			{ id: "task-b", issue_type: "task", depends_on_ids: ["task-a"] },
			{ id: "task-c", issue_type: "task", depends_on_ids: ["task-a"] },
			{ id: "task-d", issue_type: "task", depends_on_ids: ["task-a"] },
		];

		(
			loop as unknown as {
				scheduler: {
					findTasksUnblockedBy: (taskId: string) => Promise<unknown[]>;
					getInProgressTasksWithoutAgent: () => Promise<unknown[]>;
					getNextTasks: () => Promise<unknown[]>;
				};
			}
		).scheduler = {
			findTasksUnblockedBy: async () => dependents,
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
		} as never;

		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 1,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: (task: { id: string }) => spawned.push(task.id),
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "all done" });
		expect(calls.close).toEqual([{ taskId: "task-a", reason: "all done" }]);
		expect(spawned).toEqual(["task-b"]);
	});

	test("handleFinisherCloseTask unblocks blocked dependents even when auto-spawn is slot-limited", async () => {
		const { loop, calls } = createLoopFixture();
		const spawned: string[] = [];
		const dependents = [
			{ id: "task-b", issue_type: "task", status: "blocked", depends_on_ids: ["task-a"] },
			{ id: "task-c", issue_type: "task", status: "blocked", depends_on_ids: ["task-a"] },
		];

		(
			loop as unknown as {
				scheduler: {
					findTasksUnblockedBy: (taskId: string) => Promise<unknown[]>;
					getInProgressTasksWithoutAgent: () => Promise<unknown[]>;
					getNextTasks: () => Promise<unknown[]>;
				};
			}
		).scheduler = {
			findTasksUnblockedBy: async () => dependents,
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
		} as never;

		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 0,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: (task: { id: string }) => spawned.push(task.id),
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "all done" });
		expect(calls.close).toEqual([{ taskId: "task-a", reason: "all done" }]);
		expect(calls.updateStatus).toEqual([
			{ taskId: "task-b", status: "open" },
			{ taskId: "task-c", status: "open" },
		]);
		expect(spawned).toEqual([]);
	});

	test("tasks without dependencies still require explicit startTasks after close", async () => {
		const { loop, calls } = createLoopFixture();
		const autoSpawned: string[] = [];
		const manualSpawned: string[] = [];
		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 2,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: (task: { id: string }) => {
				autoSpawned.push(task.id);
				manualSpawned.push(task.id);
			},
		} as never;

		(
			loop as unknown as {
				scheduler: {
					findTasksUnblockedBy: (taskId: string) => Promise<unknown[]>;
					getInProgressTasksWithoutAgent: () => Promise<unknown[]>;
					getNextTasks: (_count: number) => Promise<unknown[]>;
				};
			}
		).scheduler = {
			findTasksUnblockedBy: async () => [],
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [{ id: "task-free" }],
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "done" });
		expect(calls.close).toEqual([{ taskId: "task-a", reason: "done" }]);
		expect(autoSpawned).toEqual([]);

		(loop as unknown as { running: boolean }).running = true;
		expect(await loop.startTasks(1)).toEqual({ spawned: 1, taskIds: ["task-free"] });
		expect(manualSpawned).toEqual(["task-free"]);
	});
});

describe("AgentLoop merger queue integration", () => {
	test("handleFinisherCloseTask queues merger when replicas are enabled and replica exists", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica } = fixture;
		const aborted: string[] = [];
		setReplica("task-r", "/tmp/replica/task-r", true);
		registerReplicaFinisher(fixture, {
			taskId: "task-r",
			agentId: "finisher:task-r",
			replicaDir: "/tmp/replica/task-r",
			onAbort: () => aborted.push("finisher:task-r"),
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		const result = await loop.handleFinisherCloseTask({
			taskId: "task-r",
			reason: "done",
			agentId: "finisher:task-r",
		});
		await Bun.sleep(5);

		expect(result).toMatchObject({
			ok: true,
			taskId: "task-r",
			queuedForMerge: true,
			replicaDir: "/tmp/replica/task-r",
		});
		expect(calls.close).toEqual([]);
		expect(aborted).toEqual(["finisher:task-r"]);
		expect(calls.spawnMerger).toEqual([{ taskId: "task-r", replicaDir: "/tmp/replica/task-r" }]);
	});

	test("handleFinisherCloseTask falls back to immediate close when finisher has no replicaDir", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls } = fixture;
		registerReplicaFinisher(fixture, {
			taskId: "task-no-replica",
			agentId: "finisher:task-no-replica",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		const result = (await loop.handleFinisherCloseTask({
			taskId: "task-no-replica",
			reason: "done",
			agentId: "finisher:task-no-replica",
		})) as { queuedForMerge?: boolean };
		await Bun.sleep(5);

		expect(result.queuedForMerge).toBeUndefined();
		expect(calls.close).toEqual([{ taskId: "task-no-replica", reason: "done" }]);
		expect(calls.spawnMerger).toEqual([]);
	});

	test("handleFinisherCloseTask falls back to immediate close when replica no longer exists", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica } = fixture;
		setReplica("task-missing-replica", "/tmp/replica/task-missing-replica", false);
		registerReplicaFinisher(fixture, {
			taskId: "task-missing-replica",
			agentId: "finisher:task-missing-replica",
			replicaDir: "/tmp/replica/task-missing-replica",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		const result = (await loop.handleFinisherCloseTask({
			taskId: "task-missing-replica",
			reason: "done",
			agentId: "finisher:task-missing-replica",
		})) as { queuedForMerge?: boolean };
		await Bun.sleep(5);

		expect(result.queuedForMerge).toBeUndefined();
		expect(calls.close).toEqual([{ taskId: "task-missing-replica", reason: "done" }]);
		expect(calls.spawnMerger).toEqual([]);
	});

	test("handleFinisherCloseTask keeps non-replica flow unchanged when replicas are disabled", async () => {
		const { loop, registry, calls } = createLoopFixture();
		registry.register({
			id: "finisher:task-disabled",
			role: "finisher",
			taskId: "task-disabled",
			tasksAgentId: "agent-finisher-task-disabled",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
			replicaDir: "/tmp/replica/task-disabled",
			rpc: makeRpc(),
		});

		await loop.handleFinisherCloseTask({ taskId: "task-disabled", reason: "done" });

		expect(calls.close).toEqual([{ taskId: "task-disabled", reason: "done" }]);
	});

	test("handleMergerComplete destroys replica, closes task, unblocks dependents, and starts next queued merger", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica, setUnblockedDependents } = fixture;
		setReplica("task-a", "/tmp/replica/task-a", true);
		setReplica("task-b", "/tmp/replica/task-b", true);
		setUnblockedDependents("task-a", [
			{
				id: "task-a-dep",
				status: "blocked",
				issue_type: "task",
				depends_on_ids: ["task-a"],
			},
		]);
		registerReplicaFinisher(fixture, {
			taskId: "task-a",
			agentId: "finisher:task-a",
			replicaDir: "/tmp/replica/task-a",
		});
		registerReplicaFinisher(fixture, {
			taskId: "task-b",
			agentId: "finisher:task-b",
			replicaDir: "/tmp/replica/task-b",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;
		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (_taskId: string) => boolean;
					kickoffNewTaskPipeline: (_task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 0,
			isPipelineInFlight: () => false,
			kickoffNewTaskPipeline: () => {},
		} as never;

		await loop.handleFinisherCloseTask({ taskId: "task-a", reason: "done", agentId: "finisher:task-a" });
		await loop.handleFinisherCloseTask({ taskId: "task-b", reason: "done", agentId: "finisher:task-b" });
		await Bun.sleep(5);
		expect(calls.spawnMerger).toEqual([{ taskId: "task-a", replicaDir: "/tmp/replica/task-a" }]);

		calls.sequence.length = 0;
		const result = await loop.handleMergerComplete({ taskId: "task-a", reason: "merged cleanly" });
		await Bun.sleep(5);

		expect(result).toMatchObject({ ok: true, taskId: "task-a" });
		expect(calls.destroyReplica).toContain("task-a");
		expect(calls.close).toContainEqual({ taskId: "task-a", reason: "merged cleanly" });
		expect(calls.updateStatus).toContainEqual({ taskId: "task-a-dep", status: "open" });
		expect(calls.spawnMerger).toEqual([
			{ taskId: "task-a", replicaDir: "/tmp/replica/task-a" },
			{ taskId: "task-b", replicaDir: "/tmp/replica/task-b" },
		]);
		const destroyIndex = calls.sequence.indexOf("destroyReplica:task-a");
		const closeIndex = calls.sequence.indexOf("close:task-a");
		const unblockIndex = calls.sequence.indexOf("updateStatus:task-a-dep:open");
		const nextSpawnIndex = calls.sequence.indexOf("spawnMerger:task-b");
		expect(destroyIndex).toBeGreaterThan(-1);
		expect(closeIndex).toBeGreaterThan(destroyIndex);
		expect(unblockIndex).toBeGreaterThan(closeIndex);
		expect(nextSpawnIndex).toBeGreaterThan(unblockIndex);
	});

	test("handleMergerConflict blocks task, comments conflict reason, keeps replica, and starts next queued merger", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica } = fixture;
		setReplica("task-c", "/tmp/replica/task-c", true);
		setReplica("task-d", "/tmp/replica/task-d", true);
		registerReplicaFinisher(fixture, {
			taskId: "task-c",
			agentId: "finisher:task-c",
			replicaDir: "/tmp/replica/task-c",
		});
		registerReplicaFinisher(fixture, {
			taskId: "task-d",
			agentId: "finisher:task-d",
			replicaDir: "/tmp/replica/task-d",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		await loop.handleFinisherCloseTask({ taskId: "task-c", reason: "done", agentId: "finisher:task-c" });
		await loop.handleFinisherCloseTask({ taskId: "task-d", reason: "done", agentId: "finisher:task-d" });
		await Bun.sleep(5);
		expect(calls.spawnMerger).toEqual([{ taskId: "task-c", replicaDir: "/tmp/replica/task-c" }]);

		calls.sequence.length = 0;
		const result = await loop.handleMergerConflict({
			taskId: "task-c",
			reason: "merge conflict in src/conflict.ts",
		});
		await Bun.sleep(5);

		expect(result).toMatchObject({
			ok: true,
			taskId: "task-c",
			reason: "merge conflict in src/conflict.ts",
		});
		expect(calls.close.find(call => call.taskId === "task-c")).toBeUndefined();
		expect(calls.updateStatus).toContainEqual({ taskId: "task-c", status: "blocked" });
		expect(calls.comment).toContainEqual({
			taskId: "task-c",
			text: "Blocked by merger conflict. merge conflict in src/conflict.ts",
		});
		expect(calls.destroyReplica).not.toContain("task-c");
		expect(calls.spawnMerger).toEqual([
			{ taskId: "task-c", replicaDir: "/tmp/replica/task-c" },
			{ taskId: "task-d", replicaDir: "/tmp/replica/task-d" },
		]);
		const blockIndex = calls.sequence.indexOf("updateStatus:task-c:blocked");
		const nextSpawnIndex = calls.sequence.indexOf("spawnMerger:task-d");
		expect(blockIndex).toBeGreaterThan(-1);
		expect(nextSpawnIndex).toBeGreaterThan(blockIndex);
	});

	test("merger queue serializes two completions FIFO", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica } = fixture;
		setReplica("task-1", "/tmp/replica/task-1", true);
		setReplica("task-2", "/tmp/replica/task-2", true);
		registerReplicaFinisher(fixture, {
			taskId: "task-1",
			agentId: "finisher:task-1",
			replicaDir: "/tmp/replica/task-1",
		});
		registerReplicaFinisher(fixture, {
			taskId: "task-2",
			agentId: "finisher:task-2",
			replicaDir: "/tmp/replica/task-2",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		await loop.handleFinisherCloseTask({ taskId: "task-1", reason: "done", agentId: "finisher:task-1" });
		await loop.handleFinisherCloseTask({ taskId: "task-2", reason: "done", agentId: "finisher:task-2" });
		await Bun.sleep(5);
		expect(calls.spawnMerger).toEqual([{ taskId: "task-1", replicaDir: "/tmp/replica/task-1" }]);

		await loop.handleMergerComplete({ taskId: "task-1", reason: "merged" });
		await Bun.sleep(5);
		expect(calls.spawnMerger).toEqual([
			{ taskId: "task-1", replicaDir: "/tmp/replica/task-1" },
			{ taskId: "task-2", replicaDir: "/tmp/replica/task-2" },
		]);
	});

	test("handleExternalTaskClose removes manually closed queued merge task and destroys replica", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica } = fixture;
		setReplica("task-merge", "/tmp/replica/task-merge", true);
		setReplica("task-manual-close", "/tmp/replica/task-manual-close", true);
		registerReplicaFinisher(fixture, {
			taskId: "task-merge",
			agentId: "finisher:task-merge",
			replicaDir: "/tmp/replica/task-merge",
		});
		registerReplicaFinisher(fixture, {
			taskId: "task-manual-close",
			agentId: "finisher:task-manual-close",
			replicaDir: "/tmp/replica/task-manual-close",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		await loop.handleFinisherCloseTask({ taskId: "task-merge", reason: "done", agentId: "finisher:task-merge" });
		await loop.handleFinisherCloseTask({
			taskId: "task-manual-close",
			reason: "done",
			agentId: "finisher:task-manual-close",
		});
		await Bun.sleep(5);
		expect(calls.spawnMerger).toEqual([{ taskId: "task-merge", replicaDir: "/tmp/replica/task-merge" }]);

		await loop.handleExternalTaskClose("task-manual-close");
		await loop.handleMergerComplete({ taskId: "task-merge", reason: "merged" });
		await Bun.sleep(5);

		expect(calls.destroyReplica).toContain("task-manual-close");
		expect(calls.spawnMerger).toEqual([{ taskId: "task-merge", replicaDir: "/tmp/replica/task-merge" }]);
	});

	test("handleExternalTaskClose removes manually deleted merge queue head and advances to next task", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, registry, setReplica } = fixture;
		setReplica("task-manual-delete", "/tmp/replica/task-manual-delete", true);
		setReplica("task-after-delete", "/tmp/replica/task-after-delete", true);
		registerReplicaFinisher(fixture, {
			taskId: "task-manual-delete",
			agentId: "finisher:task-manual-delete",
			replicaDir: "/tmp/replica/task-manual-delete",
		});
		registerReplicaFinisher(fixture, {
			taskId: "task-after-delete",
			agentId: "finisher:task-after-delete",
			replicaDir: "/tmp/replica/task-after-delete",
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;

		await loop.handleFinisherCloseTask({
			taskId: "task-manual-delete",
			reason: "done",
			agentId: "finisher:task-manual-delete",
		});
		await loop.handleFinisherCloseTask({
			taskId: "task-after-delete",
			reason: "done",
			agentId: "finisher:task-after-delete",
		});
		await Bun.sleep(5);
		expect(calls.spawnMerger).toEqual([
			{ taskId: "task-manual-delete", replicaDir: "/tmp/replica/task-manual-delete" },
		]);

		await loop.handleExternalTaskClose("task-manual-delete");
		const activeMerger = registry.getActiveByTask("task-manual-delete").find(agent => agent.role === "merger");
		if (activeMerger) registry.remove(activeMerger.id);
		await (loop as unknown as { tick: () => Promise<void> }).tick();
		await Bun.sleep(5);

		expect(calls.destroyReplica).toContain("task-manual-delete");
		expect(calls.abortMerger).toContain("task-manual-delete");
		expect(calls.spawnMerger).toEqual([
			{ taskId: "task-manual-delete", replicaDir: "/tmp/replica/task-manual-delete" },
			{ taskId: "task-after-delete", replicaDir: "/tmp/replica/task-after-delete" },
		]);
	});

	test("processMergerQueue skips missing replica head, closes it, and continues", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica, setReplicaExists } = fixture;
		setReplica("task-missing", "/tmp/replica/task-missing", true);
		setReplica("task-next", "/tmp/replica/task-next", true);
		registerReplicaFinisher(fixture, {
			taskId: "task-missing",
			agentId: "finisher:task-missing",
			replicaDir: "/tmp/replica/task-missing",
		});
		registerReplicaFinisher(fixture, {
			taskId: "task-next",
			agentId: "finisher:task-next",
			replicaDir: "/tmp/replica/task-next",
		});

		await loop.handleFinisherCloseTask({ taskId: "task-missing", reason: "done", agentId: "finisher:task-missing" });
		await loop.handleFinisherCloseTask({ taskId: "task-next", reason: "done", agentId: "finisher:task-next" });
		expect(calls.spawnMerger).toEqual([]);

		setReplicaExists("task-missing", false);
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { paused: boolean }).paused = false;
		await (loop as unknown as { tick: () => Promise<void> }).tick();
		await Bun.sleep(5);

		expect(calls.close).toContainEqual({
			taskId: "task-missing",
			reason: "Closed without merge (replica directory missing)",
		});
		expect(calls.spawnMerger).toEqual([{ taskId: "task-next", replicaDir: "/tmp/replica/task-next" }]);
	});

	test("startup restore queues in_progress replica tasks", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica, setTaskStatus } = fixture;
		setReplica("task-r", "/tmp/replica/task-r", true);
		setTaskStatus("task-r", "in_progress");

		loop.start();
		await Bun.sleep(20);
		await loop.stop();

		expect(calls.listReplicas).toBeGreaterThan(0);
		expect(calls.show).toContain("task-r");
		expect(calls.spawnMerger).toEqual([{ taskId: "task-r", replicaDir: "/tmp/replica/task-r" }]);
	});

	test("startup restore skips replicas for tasks not in progress", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica, setTaskStatus } = fixture;
		setReplica("task-closed", "/tmp/replica/task-closed", true);
		setTaskStatus("task-closed", "closed");

		loop.start();
		await Bun.sleep(20);
		await loop.stop();

		expect(calls.listReplicas).toBeGreaterThan(0);
		expect(calls.show).toContain("task-closed");
		expect(calls.spawnMerger).toEqual([]);
	});

	test("startup restore destroys orphaned replica when task lookup fails", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls, setReplica, setShowError } = fixture;
		setReplica("task-deleted", "/tmp/replica/task-deleted", true);
		setShowError("task-deleted", new Error("task not found"));

		loop.start();
		await Bun.sleep(20);
		await loop.stop();

		expect(calls.show).toContain("task-deleted");
		expect(calls.destroyReplica).toContain("task-deleted");
		expect(calls.spawnMerger).toEqual([]);
	});

	test("startup restore with empty replica directories leaves queue empty", async () => {
		const fixture = createLoopWithReplicasFixture();
		const { loop, calls } = fixture;

		loop.start();
		await Bun.sleep(20);
		await loop.stop();

		expect(calls.listReplicas).toBeGreaterThan(0);
		expect(calls.show).toEqual([]);
		expect(calls.spawnMerger).toEqual([]);
	});
});

describe("AgentLoop finisher exit routing", () => {
	const registerRunningFinisher = (fixture: ReturnType<typeof createLoopFixture>, taskId: string, id: string) =>
		fixture.registry.register({
			id,
			role: "finisher",
			taskId,
			tasksAgentId: `agent-${id}`,
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
			rpc: makeRpc({
				forceKill: () => {},
				getLastAssistantText: async () => "finisher output",
			}),
		});

	test("finisher exit without close/advance respawns a finisher", async () => {
		const fixture = createLoopFixture();
		const { loop, calls } = fixture;
		(loop as unknown as { running: boolean }).running = true;
		const respawns: Array<{ taskId: string; workerOutput: string }> = [];

		(
			loop as unknown as {
				steeringManager: {
					spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<unknown>;
				};
			}
		).steeringManager.spawnFinisherAfterStoppingSteering = async (taskId: string, workerOutput: string) => {
			respawns.push({ taskId, workerOutput });
			return {
				id: `finisher:${taskId}:retry`,
				role: "finisher",
				taskId,
				tasksAgentId: `agent-finisher-${taskId}-retry`,
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: 3,
				lastActivity: 4,
			};
		};

		const finisher = registerRunningFinisher(fixture, "task-respawn", "finisher:task-respawn:old");
		await (
			loop as unknown as {
				rpcHandlerManager: { onAgentEnd: (agent: unknown) => Promise<void> };
			}
		).rpcHandlerManager.onAgentEnd(finisher);

		expect(respawns).toHaveLength(1);
		expect(respawns[0]?.taskId).toBe("task-respawn");
		expect(respawns[0]?.workerOutput).toContain("[SYSTEM RECOVERY]");
		expect(calls.setAgentState).toContainEqual({ id: "agent-finisher:task-respawn:old", state: "done" });
	});

	test("finisher advance_lifecycle routes worker, issuer, and defer actions", async () => {
		const runCase = async (action: "worker" | "issuer" | "defer") => {
			const fixture = createLoopFixture();
			const { loop, calls } = fixture;
			(loop as unknown as { running: boolean }).running = true;
			const workerSpawns: Array<{ taskId: string; kickoffMessage: string | null | undefined }> = [];
			const issuerKickoffs: string[] = [];

			(
				loop as unknown as {
					tasksClient: {
						show: (taskId: string) => Promise<{ id: string; title: string; status: string; issue_type: string }>;
					};
				}
			).tasksClient.show = async taskId => ({
				id: taskId,
				title: `Task ${taskId}`,
				status: "in_progress",
				issue_type: "task",
			});

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (
							task: { id: string },
							opts?: { claim?: boolean; kickoffMessage?: string | null },
						) => Promise<unknown>;
						kickoffResumePipeline: (task: { id: string }) => void;
					};
				}
			).pipelineManager.spawnTaskWorker = async (
				task: { id: string },
				opts?: { kickoffMessage?: string | null },
			) => {
				workerSpawns.push({ taskId: task.id, kickoffMessage: opts?.kickoffMessage });
				return {
					id: `worker:${task.id}:new`,
					role: "worker",
					taskId: task.id,
					tasksAgentId: `agent-worker-${task.id}`,
					status: "running",
					usage: createEmptyAgentUsage(),
					events: [],
					spawnedAt: 3,
					lastActivity: 4,
				};
			};
			(
				loop as unknown as {
					pipelineManager: {
						kickoffResumePipeline: (task: { id: string }) => void;
					};
				}
			).pipelineManager.kickoffResumePipeline = (task: { id: string }) => {
				issuerKickoffs.push(task.id);
			};

			const finisher = registerRunningFinisher(fixture, `task-${action}`, `finisher:task-${action}:old`);
			loop.advanceFinisherLifecycle({
				taskId: `task-${action}`,
				action,
				message: `message-${action}`,
				reason: `reason-${action}`,
				agentId: "fin-1",
			});

			await (
				loop as unknown as {
					rpcHandlerManager: { onAgentEnd: (agent: unknown) => Promise<void> };
				}
			).rpcHandlerManager.onAgentEnd(finisher);

			return { workerSpawns, issuerKickoffs, calls };
		};

		const workerCase = await runCase("worker");
		expect(workerCase.workerSpawns).toEqual([{ taskId: "task-worker", kickoffMessage: "message-worker" }]);
		expect(workerCase.issuerKickoffs).toEqual([]);
		expect(workerCase.calls.updateStatus).toEqual([]);

		const issuerCase = await runCase("issuer");
		expect(issuerCase.workerSpawns).toEqual([]);
		expect(issuerCase.issuerKickoffs).toEqual(["task-issuer"]);
		expect(issuerCase.calls.updateStatus).toEqual([]);

		const deferCase = await runCase("defer");
		expect(deferCase.workerSpawns).toEqual([]);
		expect(deferCase.issuerKickoffs).toEqual([]);
		expect(deferCase.calls.updateStatus).toEqual([{ taskId: "task-defer", status: "blocked" }]);
		expect(deferCase.calls.comment).toEqual([
			{ taskId: "task-defer", text: "Blocked by finisher advance_lifecycle. reason-defer\nmessage: message-defer" },
		]);
	});

	test("finisher issuer advance skips kickoff when task is already blocked", async () => {
		const fixture = createLoopFixture();
		const { loop } = fixture;
		(loop as unknown as { running: boolean }).running = true;
		const issuerKickoffs: string[] = [];

		(
			loop as unknown as {
				tasksClient: {
					show: (taskId: string) => Promise<{ id: string; title: string; status: string; issue_type: string }>;
				};
			}
		).tasksClient.show = async taskId => ({
			id: taskId,
			title: `Task ${taskId}`,
			status: "blocked",
			issue_type: "task",
		});
		(
			loop as unknown as {
				pipelineManager: {
					kickoffResumePipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager.kickoffResumePipeline = (task: { id: string }) => {
			issuerKickoffs.push(task.id);
		};

		const finisher = registerRunningFinisher(fixture, "task-issuer-blocked", "finisher:task-issuer-blocked:old");
		loop.advanceFinisherLifecycle({
			taskId: "task-issuer-blocked",
			action: "issuer",
			message: "message-issuer-blocked",
			reason: "reason-issuer-blocked",
			agentId: "fin-1",
		});

		await (
			loop as unknown as {
				rpcHandlerManager: { onAgentEnd: (agent: unknown) => Promise<void> };
			}
		).rpcHandlerManager.onAgentEnd(finisher);

		expect(issuerKickoffs).toEqual([]);
	});
});

test("steer/interrupt/broadcast delegate only while running", async () => {
	const { loop } = createLoopFixture();
	const calls: { steer: unknown[]; interrupt: unknown[]; broadcast: unknown[] } = {
		steer: [],
		interrupt: [],
		broadcast: [],
	};
	(
		loop as unknown as {
			steeringManager: {
				steerAgent: (taskId: string, message: string) => Promise<boolean>;
				interruptAgent: (taskId: string, message: string) => Promise<boolean>;
				broadcastToWorkers: (message: string, meta?: unknown) => Promise<void>;
			};
		}
	).steeringManager = {
		steerAgent: async (taskId: string, message: string) => {
			calls.steer.push({ taskId, message });
			return true;
		},
		interruptAgent: async (taskId: string, message: string) => {
			calls.interrupt.push({ taskId, message });
			return true;
		},
		broadcastToWorkers: async (message: string, meta?: unknown) => {
			calls.broadcast.push({ message, meta });
		},
	};

	expect(await loop.steerAgent("task-1", "msg")).toBe(false);
	expect(await loop.interruptAgent("task-1", "msg")).toBe(false);
	await loop.broadcastToWorkers("msg");
	expect(calls.broadcast).toHaveLength(0);

	(loop as unknown as { running: boolean }).running = true;
	expect(await loop.steerAgent("task-1", "msg")).toBe(true);
	expect(await loop.interruptAgent("task-1", "msg")).toBe(true);
	await loop.broadcastToWorkers("hello", { source: "test" });
	expect(calls.steer).toEqual([{ taskId: "task-1", message: "msg" }]);
	expect(calls.interrupt).toEqual([{ taskId: "task-1", message: "msg" }]);
	expect(calls.broadcast).toEqual([{ message: "hello", meta: { source: "test" } }]);
});

describe("AgentLoop tick behavior", () => {
	test("does not re-enter tick while one tick is in flight", async () => {
		const { loop } = createLoopFixture();
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { running: boolean; paused: boolean }).paused = false;

		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});

		let getNextCalls = 0;
		(
			loop as unknown as {
				scheduler: {
					getInProgressTasksWithoutAgent: (count: number) => Promise<unknown[]>;
					getNextTasks: (count: number) => Promise<unknown[]>;
				};
			}
		).scheduler = {
			getInProgressTasksWithoutAgent: async (_count: number) => [],
			getNextTasks: async (_count: number) => {
				getNextCalls += 1;
				await gate;
				return [];
			},
		};

		let steerCalls = 0;
		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (taskId: string) => boolean;
					kickoffResumePipeline: (task: unknown) => void;
					kickoffNewTaskPipeline: (task: unknown) => void;
				};
				steeringManager: { maybeSteerWorkers: (paused: boolean) => Promise<void> };
			}
		).pipelineManager = {
			availableWorkerSlots: () => 1,
			isPipelineInFlight: () => false,
			kickoffResumePipeline: () => {},
			kickoffNewTaskPipeline: () => {},
		};
		(
			loop as unknown as { steeringManager: { maybeSteerWorkers: (paused: boolean) => Promise<void> } }
		).steeringManager = {
			maybeSteerWorkers: async () => {
				steerCalls += 1;
			},
		};

		const tick = (loop as unknown as { tick: () => Promise<void> }).tick.bind(loop);
		const p1 = tick();
		const p2 = tick();
		await Bun.sleep(5);
		release();
		await Promise.all([p1, p2]);

		expect(getNextCalls).toBe(0);
		expect(steerCalls).toBe(1);
	});
	test("startTasks starts ready tasks on demand and can limit work", async () => {
		const { loop } = createLoopFixture();
		(loop as unknown as { running: boolean }).running = true;
		const getNextCalls: number[] = [];
		const spawned: string[] = [];

		(
			loop as unknown as {
				scheduler: {
					getNextTasks: (count: number) => Promise<unknown[]>;
				};
			}
		).scheduler = {
			getNextTasks: async (count: number) => {
				getNextCalls.push(count);
				return [{ id: "task-1" }, { id: "task-2" }, { id: "task-3" }] as unknown[];
			},
		};
		(
			loop as unknown as {
				pipelineManager: {
					availableWorkerSlots: () => number;
					isPipelineInFlight: (taskId: string) => boolean;
					kickoffNewTaskPipeline: (task: { id: string }) => void;
				};
			}
		).pipelineManager = {
			availableWorkerSlots: () => 3,
			isPipelineInFlight: taskId => taskId === "task-2",
			kickoffNewTaskPipeline: task => spawned.push(task.id),
		};

		expect(await loop.startTasks(2)).toEqual({ spawned: 2, taskIds: ["task-1", "task-3"] });
		expect(getNextCalls).toEqual([2]);
		expect(spawned).toEqual(["task-1", "task-3"]);

		(loop as unknown as { paused: boolean }).paused = true;
		expect(await loop.startTasks(1)).toEqual({ spawned: 0, taskIds: [] });
	});
});
