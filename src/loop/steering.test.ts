import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import { type AgentInfo, createEmptyAgentUsage } from "../agents/types";
import { DEFAULT_CONFIG } from "../config";
import type { TaskStoreClient } from "../tasks/client";
import { SteeringManager } from "./steering";

function makeRpc(overrides: Record<string, unknown> = {}): OmsRpcClient {
	const rpc = Object.create(OmsRpcClient.prototype) as OmsRpcClient & Record<string, unknown>;
	Object.assign(rpc, {
		steer: async (_message: string) => {},
		abort: async () => {},
		stop: async () => {},
		waitForAgentEnd: async (_timeoutMs?: number) => {},
		getLastAssistantText: async () => null,
		getMessages: async () => [],
		onEvent: (_listener: (event: unknown) => void) => () => {},
		forceKill: () => {},
		...overrides,
	});
	return rpc;
}

function makeAgent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
	return {
		id,
		role: "worker",
		taskId: "task-1",
		tasksAgentId: id,
		status: "running",
		usage: createEmptyAgentUsage(),
		events: [],
		spawnedAt: 1,
		lastActivity: 1,
		...overrides,
	};
}

function createManager(opts?: {
	registry?: AgentRegistry;
	spawner?: Record<string, unknown>;
	stopAgentsMatching?: (pred: (a: AgentInfo) => boolean) => Promise<Set<string>>;
}) {
	const tasksClient = {} as unknown as TaskStoreClient;
	const registry = opts?.registry ?? new AgentRegistry({ tasksClient });
	const spawner = (opts?.spawner ?? {
		spawnFinisher: async (taskId: string) => makeAgent(`finisher:${taskId}`, { role: "finisher", taskId }),
		spawnSteering: async (taskId: string) => makeAgent(`steering:${taskId}`, { role: "steering", taskId }),
		spawnBroadcastSteering: async () => makeAgent("steering:broadcast", { role: "steering", taskId: null }),
	}) as never;

	const attachCalls: string[] = [];
	const finishCalls: Array<{ id: string; status: string }> = [];
	const startCalls: string[] = [];
	const finishedLogs: Array<{ id: string; text?: string }> = [];
	const loopLogs: Array<{ message: string; level: string }> = [];
	const manager = new SteeringManager({
		registry,
		spawner,
		config: { ...DEFAULT_CONFIG, steeringIntervalMs: 1 },
		loopLog: (message, level) => {
			loopLogs.push({ message, level });
		},
		onDirty: () => {},
		attachRpcHandlers: agent => {
			attachCalls.push(agent.id);
		},
		finishAgent: async (agent, status) => {
			finishCalls.push({ id: agent.id, status });
		},
		logAgentStart: (_startedBy, agent) => {
			startCalls.push(agent.id);
		},
		logAgentFinished: async (agent, text) => {
			finishedLogs.push({ id: agent.id, text });
		},
		stopAgentsMatching:
			opts?.stopAgentsMatching ??
			(async () => {
				return new Set<string>();
			}),
	});

	return { manager, registry, attachCalls, finishCalls, startCalls, finishedLogs, loopLogs };
}

describe("SteeringManager", () => {
	test("getActiveWorkerAgents filters by role and terminal status", () => {
		const { manager, registry } = createManager();
		registry.register(makeAgent("worker-1", { role: "worker", status: "running" }));
		registry.register(makeAgent("designer-1", { role: "designer-worker", status: "working" }));
		registry.register(makeAgent("worker-done", { role: "worker", status: "done" }));
		registry.register(makeAgent("finisher-1", { role: "finisher", status: "running" }));

		const active = manager
			.getActiveWorkerAgents()
			.map(agent => agent.id)
			.sort();
		expect(active).toEqual(["designer-1", "worker-1"]);
	});

	test("hasFinisherTakeover reflects active finisher", () => {
		const { manager, registry } = createManager();
		registry.register(makeAgent("finisher-1", { role: "finisher", taskId: "task-1" }));
		expect(manager.hasFinisherTakeover("task-1")).toBe(true);
		expect(manager.hasFinisherTakeover("task-2")).toBe(false);
	});

	test("steerAgent sends summary message to active non-finisher agents", async () => {
		const steerCalls: string[] = [];
		const { manager, registry } = createManager();
		registry.register(
			makeAgent("worker-1", {
				role: "worker",
				taskId: "task-1",
				rpc: makeRpc({ steer: async (msg: string) => steerCalls.push(msg) }),
			}),
		);
		registry.register(
			makeAgent("finisher-1", {
				role: "finisher",
				taskId: "task-1",
				rpc: makeRpc({ steer: async (msg: string) => steerCalls.push(`finisher:${msg}`) }),
			}),
		);

		expect(await manager.steerAgent("task-1", "  move to focused scope  ")).toBe(true);
		expect(steerCalls).toEqual(["move to focused scope"]);
		expect(await manager.steerAgent("task-1", "   ")).toBe(false);
		expect(await manager.steerAgent("", "x")).toBe(false);
	});

	test("interruptAgent sends urgent steer and asks stopper to abort targets", async () => {
		const steerCalls: string[] = [];
		let stoppedAgentIds: string[] = [];
		const { manager, registry } = createManager({
			stopAgentsMatching: async pred => {
				stoppedAgentIds = registry
					.getActive()
					.filter(pred)
					.map(agent => agent.id);
				return new Set(["task-1"]);
			},
		});
		registry.register(
			makeAgent("worker-1", {
				role: "worker",
				taskId: "task-1",
				rpc: makeRpc({ steer: async (msg: string) => steerCalls.push(msg) }),
			}),
		);
		registry.register(
			makeAgent("worker-2", {
				role: "worker",
				taskId: "task-1",
				rpc: makeRpc({ steer: async (msg: string) => steerCalls.push(msg) }),
			}),
		);

		const ok = await manager.interruptAgent("task-1", "stop and reset");
		expect(ok).toBe(true);
		expect(steerCalls[0]).toBe("[URGENT INTERRUPT]\n\nstop and reset");
		expect(stoppedAgentIds.sort()).toEqual(["worker-1", "worker-2"]);
	});

	test("broadcastToWorkers routes steering decisions to workers", async () => {
		const workerSteers: string[] = [];
		const worker = makeAgent("worker-1", {
			role: "worker",
			taskId: "task-1",
			rpc: makeRpc({ steer: async (msg: string) => workerSteers.push(msg) }),
		});
		const steeringRpc = makeRpc({
			waitForAgentEnd: async () => {},
			getLastAssistantText: async () =>
				JSON.stringify({
					decisions: [{ taskId: "task-1", action: "steer", message: "keep focus", reason: "drift" }],
				}),
		});
		const { manager, registry, attachCalls, finishCalls, finishedLogs } = createManager({
			spawner: {
				spawnBroadcastSteering: async () =>
					makeAgent("steering-broadcast", { role: "steering", taskId: null, rpc: steeringRpc }),
				spawnFinisher: async (taskId: string, workerOutput: string) =>
					makeAgent(`finisher:${taskId}`, {
						role: "finisher",
						taskId,
						events: [{ type: "log", ts: Date.now(), message: workerOutput }],
					}),
				spawnSteering: async (taskId: string) => makeAgent(`steering:${taskId}`, { role: "steering", taskId }),
			},
		});
		registry.register(worker);

		await manager.broadcastToWorkers("global guidance", { urgency: "critical" });
		expect(workerSteers).toEqual(["keep focus"]);
		expect(attachCalls).toContain("steering-broadcast");
		expect(finishCalls).toContainEqual({ id: "steering-broadcast", status: "done" });
		expect(finishedLogs.find(entry => entry.id === "steering-broadcast")).toBeDefined();
	});

	test("broadcastToWorkers ignores empty messages", async () => {
		let spawned = 0;
		const { manager, registry } = createManager({
			spawner: {
				spawnBroadcastSteering: async () => {
					spawned += 1;
					return makeAgent("steering-broadcast", { role: "steering", taskId: null, rpc: makeRpc() });
				},
				spawnSteering: async (taskId: string) => makeAgent(`steering:${taskId}`, { role: "steering", taskId }),
				spawnFinisher: async (taskId: string) => makeAgent(`finisher:${taskId}`, { role: "finisher", taskId }),
			},
		});
		registry.register(makeAgent("worker-1", { role: "worker", rpc: makeRpc() }));

		await manager.broadcastToWorkers("   ");
		expect(spawned).toBe(0);
	});

	test("spawnFinisherAfterStoppingSteering marks takeover during in-flight spawn", async () => {
		let release: () => void = () => {};
		const blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		const { manager } = createManager({
			spawner: {
				spawnFinisher: async (taskId: string, workerOutput: string) =>
					makeAgent(`finisher:${taskId}`, {
						role: "finisher",
						taskId,
						events: [{ type: "log", ts: Date.now(), message: workerOutput }],
					}),
				spawnSteering: async (taskId: string) => makeAgent(`steering:${taskId}`, { role: "steering", taskId }),
				spawnBroadcastSteering: async () => makeAgent("steering-broadcast", { role: "steering", taskId: null }),
			},
		});
		(manager as unknown as { stopSteeringForFinisher: (taskId: string) => Promise<void> }).stopSteeringForFinisher =
			async () => {
				await blocked;
			};

		const pending = manager.spawnFinisherAfterStoppingSteering("task-77", "output");
		expect(manager.hasFinisherTakeover("task-77")).toBe(true);
		release();
		const finisher = await pending;
		expect(finisher.role).toBe("finisher");
		expect(manager.hasFinisherTakeover("task-77")).toBe(false);
	});

	test("maybeSteerWorkers avoids duplicate in-flight steering per worker", async () => {
		const { manager, registry } = createManager();
		registry.register(makeAgent("worker-1", { role: "worker", taskId: "task-1", spawnedAt: 0 }));

		const calls: string[] = [];
		let release: () => void = () => {};
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		(manager as unknown as { runSteeringForWorker: (worker: AgentInfo) => Promise<void> }).runSteeringForWorker =
			async worker => {
				calls.push(worker.id);
				await gate;
			};

		await manager.maybeSteerWorkers(false);
		await manager.maybeSteerWorkers(false);
		expect(calls).toEqual(["worker-1"]);
		release();
		await Bun.sleep(0);
	});

	test("runResumeSteering returns start=true for steer and false for interrupt", async () => {
		const steeringRpcSteer = makeRpc({
			waitForAgentEnd: async () => {},
			getLastAssistantText: async () => JSON.stringify({ action: "steer", message: "resume from here" }),
		});
		const { manager: managerSteer } = createManager({
			spawner: {
				spawnIssuer: async (taskId: string) =>
					makeAgent(`issuer:${taskId}`, { role: "issuer", taskId, rpc: steeringRpcSteer }),
				spawnSteering: async (taskId: string) => makeAgent(`steering:${taskId}`, { role: "steering", taskId }),
				spawnFinisher: async (taskId: string) => makeAgent(`finisher:${taskId}`, { role: "finisher", taskId }),
				spawnBroadcastSteering: async () => makeAgent("steering-broadcast", { role: "steering", taskId: null }),
			},
		});

		const steerResult = await managerSteer.runResumeSteering("task-1");
		expect(steerResult).toEqual({ action: "start", message: "resume from here", reason: null });

		const steeringRpcInterrupt = makeRpc({
			waitForAgentEnd: async () => {},
			getLastAssistantText: async () => JSON.stringify({ action: "interrupt", reason: "needs clarification" }),
		});
		const { manager: managerInterrupt } = createManager({
			spawner: {
				spawnIssuer: async (taskId: string) =>
					makeAgent(`issuer:${taskId}`, { role: "issuer", taskId, rpc: steeringRpcInterrupt }),
				spawnSteering: async (taskId: string) => makeAgent(`steering2:${taskId}`, { role: "steering", taskId }),
				spawnFinisher: async (taskId: string) => makeAgent(`finisher:${taskId}`, { role: "finisher", taskId }),
				spawnBroadcastSteering: async () => makeAgent("steering-broadcast", { role: "steering", taskId: null }),
			},
		});

		const interruptResult = await managerInterrupt.runResumeSteering("task-2");
		expect(interruptResult.action).toBe("defer");
		expect(interruptResult.reason).toContain("needs clarification");
	});
});
