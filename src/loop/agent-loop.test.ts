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
	};
	const tasksClient = {
		close: async (taskId: string, reason?: string) => {
			calls.close.push({ taskId, reason });
		},
		updateStatus: async (taskId: string, status: string) => {
			calls.updateStatus.push({ taskId, status });
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
