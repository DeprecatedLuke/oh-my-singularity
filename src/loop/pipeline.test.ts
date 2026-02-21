import { describe, expect, test } from "bun:test";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { type IssuerResult, PipelineManager } from "./pipeline";

type ActiveWorkerProvider = () => AgentInfo[];

const makeTask = (id: string): TaskIssue => ({
	id,
	title: `Task ${id}`,
	description: `Description ${id}`,
	acceptance_criteria: `Acceptance ${id}`,
	issue_type: "task",
	created_at: new Date().toISOString(),
	updated_at: new Date().toISOString(),
	status: "in_progress",
	assignee: null,
	labels: [],
	priority: 2,
});

const makeWorker = (taskId: string, id = `worker:${taskId}`): AgentInfo => ({
	id,
	taskId,
	agentType: "worker",
	tasksAgentId: `tasks-${id}`,
	status: "running",
	usage: createEmptyAgentUsage(),
	events: [],
	spawnedAt: Date.now(),
	lastActivity: Date.now(),
	model: undefined,
	thinking: undefined,
});

const makeIssuer = (taskId: string, rpc: OmsRpcClient, id = `issuer:${taskId}`): AgentInfo => ({
	id,
	taskId,
	agentType: "issuer",
	tasksAgentId: `tasks-${id}`,
	status: "working",
	usage: createEmptyAgentUsage(),
	events: [],
	spawnedAt: Date.now(),
	lastActivity: Date.now(),
	model: undefined,
	thinking: undefined,
	rpc,
	sessionId: `session-${taskId}`,
});

const createPipeline = (opts: {
	activeWorkers?: ActiveWorkerProvider;
	runIssuerForTask?: () => Promise<IssuerResult>;
	spawnWorker?: (task: TaskIssue, claim?: boolean, kickoffMessage?: string | null) => Promise<AgentInfo>;
}) => {
	const calls = {
		runIssuerForTask: 0,
		spawnWorker: 0,
	};
	const activeWorkers: ActiveWorkerProvider = opts.activeWorkers ?? (() => []);
	const pipeline = new PipelineManager({
		tasksClient: {
			updateStatus: async () => {},
			comment: async () => {},
		} as unknown as TaskStoreClient,
		registry: {} as never,
		scheduler: {} as never,
		spawner: {
			spawnAgent: async (configKey: string, taskId: string) => {
				if (configKey === "worker" || configKey === "designer" || configKey === "speedy") {
					calls.spawnWorker += 1;
					if (opts.spawnWorker) {
						return opts.spawnWorker(makeTask(taskId), false, undefined);
					}
					if (configKey === "designer") {
						return { ...makeWorker("designer"), agentType: "designer" } as never;
					}
				}
				return makeWorker(taskId);
			},
		} as never,
		getMaxWorkers: () => 1,
		getActiveWorkerAgents: activeWorkers,
		loopLog: () => {},
		onDirty: () => {},
		wake: () => {},
		attachRpcHandlers: () => {},
		finishAgent: async () => {},
		logAgentStart: () => {},
		logAgentFinished: async () => {},
		hasPendingInterruptKickoff: () => false,
		takePendingInterruptKickoff: () => null,
		hasFinisherTakeover: () => false,
		spawnFinisherAfterStoppingSteering: async () => {
			throw new Error("Unexpected finisher spawn");
		},
		isRunning: () => true,
		isPaused: () => false,
	});
	(
		pipeline as unknown as {
			runIssuerForTask: (task: TaskIssue, opts?: { kickoffMessage?: string }) => Promise<IssuerResult>;
		}
	).runIssuerForTask = async () => {
		calls.runIssuerForTask += 1;
		if (opts.runIssuerForTask) return opts.runIssuerForTask();
		return { start: true, message: null, reason: null, raw: null };
	};
	return { pipeline, calls, activeWorkers };
};

describe("PipelineManager resume pipeline", () => {
	test("runResumePipeline skips worker spawn when an active worker already exists", async () => {
		const task = makeTask("task-1");
		const activeWorker = makeWorker(task.id, "worker-existing");
		const { pipeline, calls } = createPipeline({
			activeWorkers: () => [activeWorker],
			runIssuerForTask: async () => ({ start: true, message: "resume", reason: null, raw: null }),
			spawnWorker: async () => {
				throw new Error("unreachable");
			},
		});

		await (pipeline as unknown as { runResumePipeline: (task: TaskIssue) => Promise<void> }).runResumePipeline(task);
		expect(calls.runIssuerForTask).toBe(1);
		expect(calls.spawnWorker).toBe(0);
	});

	test("waitForAgentEnd ignores suppressed abort agent_end and resolves on the next turn end", async () => {
		const rpc = new OmsRpcClient();
		const emitEvent = (
			rpc as unknown as {
				emitEvent: (event: unknown) => void;
			}
		).emitEvent.bind(rpc) as (event: unknown) => void;
		let resolved = false;
		const waitPromise = rpc.waitForAgentEnd(500).then(() => {
			resolved = true;
		});

		rpc.suppressNextAgentEnd();
		emitEvent({ type: "agent_end" });
		await Bun.sleep(0);
		expect(resolved).toBe(false);

		emitEvent({ type: "agent_end" });
		await waitPromise;
		expect(resolved).toBe(true);
	});

	test("waitForAgentEnd honors stacked suppressions", async () => {
		const rpc = new OmsRpcClient();
		const emitEvent = (
			rpc as unknown as {
				emitEvent: (event: unknown) => void;
			}
		).emitEvent.bind(rpc) as (event: unknown) => void;
		let resolved = false;
		const waitPromise = rpc.waitForAgentEnd(500).then(() => {
			resolved = true;
		});

		rpc.suppressNextAgentEnd();
		rpc.suppressNextAgentEnd();
		emitEvent({ type: "agent_end" });
		await Bun.sleep(0);
		expect(resolved).toBe(false);

		emitEvent({ type: "agent_end" });
		await Bun.sleep(0);
		expect(resolved).toBe(false);

		emitEvent({ type: "agent_end" });
		await waitPromise;
		expect(resolved).toBe(true);
	});
});

describe("PipelineManager issuer lifecycle recovery", () => {
	test("runIssuerForTask consumes advance_lifecycle record on normal exit (no forceKill)", async () => {
		const task = makeTask("task-advance");
		const rpc = new OmsRpcClient();
		const issuer = makeIssuer(task.id, rpc, "issuer-task-advance");
		const finishCalls: Array<{ id: string; status: "done" | "stopped" | "dead" }> = [];
		const logFinishedCalls: string[] = [];
		let spawnIssuerCalls = 0;
		let resumeAgentCalls = 0;
		let pipeline: PipelineManager;
		("advance completed");
		// waitForAgentEnd succeeds normally — agent exits after advance_lifecycle tool returns.
		// The lifecycle record is stored during the tool call; the normal path consumes it.
		(rpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd = async () => {
			pipeline.advanceLifecycle({
				agentType: "issuer",
				taskId: task.id,
				action: "advance",
				target: "worker",
				message: "ship it",
				reason: "ready",
				agentId: issuer.id,
			});
		};
		pipeline = new PipelineManager({
			tasksClient: {
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: (queryTaskId: string) => (queryTaskId === task.id ? [issuer] : []),
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnIssuer: async () => {
					spawnIssuerCalls += 1;
					return issuer;
				},
				resumeAgent: async () => {
					resumeAgentCalls += 1;
					throw new Error("resumeAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async (agent, status) => {
				finishCalls.push({ id: agent.id, status });
			},
			logAgentStart: () => {},
			logAgentFinished: async (_agent, explicitText) => {
				logFinishedCalls.push(explicitText ?? "");
			},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});
		const result = await pipeline.runIssuerForTask(task);
		expect(result.start).toBe(true);
		expect(result.message).toBe("ship it");
		expect(result.reason).toBe("ready");
		expect(typeof result.raw).toBe("string");
		expect(result.raw ? JSON.parse(result.raw) : null).toMatchObject({
			action: "advance",
			target: "worker",
			message: "ship it",
			reason: "ready",
			agentId: issuer.id,
		});
		expect(spawnIssuerCalls).toBe(1);
		expect(resumeAgentCalls).toBe(0);
		expect(finishCalls).toEqual([{ id: issuer.id, status: "done" }]);
		expect(logFinishedCalls.length).toBe(1);
	});

	test("runIssuerForTask consumes advance_lifecycle record when agent is force-killed", async () => {
		const task = makeTask("task-force-kill");
		const rpc = new OmsRpcClient();
		const issuer = makeIssuer(task.id, rpc, "issuer-task-force-kill");
		const finishCalls: Array<{ id: string; status: "done" | "stopped" | "dead" }> = [];
		const logFinishedCalls: string[] = [];
		let spawnIssuerCalls = 0;
		let pipeline: PipelineManager;

		// waitForAgentEnd rejects — simulating forceKill() after advance_lifecycle.
		// The lifecycle record is stored before the kill; the catch path consumes it.
		(rpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd = async () => {
			pipeline.advanceLifecycle({
				agentType: "issuer",
				taskId: task.id,
				action: "advance",
				target: "worker",
				message: "done",
				reason: "completed",
				agentId: issuer.id,
			});
			throw new Error("RPC process force-killed");
		};
		(rpc as unknown as { getLastAssistantText: () => Promise<string | null> }).getLastAssistantText = async () =>
			"force-kill final text";

		pipeline = new PipelineManager({
			tasksClient: {
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: (queryTaskId: string) => (queryTaskId === task.id ? [issuer] : []),
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnIssuer: async () => {
					spawnIssuerCalls += 1;
					return issuer;
				},
				resumeAgent: async () => {
					throw new Error("resumeAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async (agent, status) => {
				finishCalls.push({ id: agent.id, status });
			},
			logAgentStart: () => {},
			logAgentFinished: async (_agent, explicitText) => {
				logFinishedCalls.push(explicitText ?? "");
			},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});
		const result = await pipeline.runIssuerForTask(task);
		expect(result.start).toBe(true);
		expect(result.message).toBe("done");
		expect(result.reason).toBe("completed");
		expect(typeof result.raw).toBe("string");
		expect(result.raw ? JSON.parse(result.raw) : null).toMatchObject({
			action: "advance",
			target: "worker",
			message: "done",
			reason: "completed",
			agentId: issuer.id,
		});
		expect(spawnIssuerCalls).toBe(1);
		expect(finishCalls).toEqual([{ id: issuer.id, status: "done" }]);
		expect(logFinishedCalls.length).toBe(1);
		expect(logFinishedCalls[0]).toBe("force-kill final text");
	});

	test("runIssuerForTask sends a resume kickoff when recovering with a session id", async () => {
		const task = makeTask("task-resume-kickoff");
		const initialRpc = new OmsRpcClient();
		const resumedRpc = new OmsRpcClient();
		let resumeKickoff: string | undefined;
		let showCalls = 0;
		let pipeline: PipelineManager;

		const initialIssuer = makeIssuer(task.id, initialRpc, "issuer-task-resume-initial");
		initialIssuer.sessionId = "resume-session-1";
		const resumedIssuer = makeIssuer(task.id, resumedRpc, "issuer-task-resume-resumed");
		resumedIssuer.sessionId = "resume-session-1";

		(initialRpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd =
			async () => {
				throw new Error("issuer crashed");
			};
		(initialRpc as unknown as { getLastAssistantText: () => Promise<string | null> }).getLastAssistantText =
			async () => "initial crash";

		(resumedRpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd =
			async () => {
				pipeline.advanceLifecycle({
					agentType: "issuer",
					taskId: task.id,
					action: "advance",
					target: "worker",
					message: "resume work",
					reason: "recovered",
					agentId: resumedIssuer.id,
				});
				throw new Error("RPC process exited before agent_end");
			};
		(resumedRpc as unknown as { getLastAssistantText: () => Promise<string | null> }).getLastAssistantText =
			async () => "resume advanced";

		pipeline = new PipelineManager({
			tasksClient: {
				show: async () => {
					showCalls += 1;
					return task;
				},
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: () => [resumedIssuer],
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnIssuer: async () => initialIssuer,
				resumeAgent: async (_taskId: string, _sessionId: string, kickoffMessage?: string) => {
					resumeKickoff = kickoffMessage;
					return resumedIssuer;
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});

		const result = await pipeline.runIssuerForTask(task);
		expect(result.start).toBe(true);
		expect(result.message).toBe("resume work");
		expect(result.reason).toBe("recovered");
		expect(typeof resumeKickoff).toBe("string");
		expect(resumeKickoff).toContain("[SYSTEM RECOVERY]");
		expect(resumeKickoff).toContain("advance_lifecycle");
		expect(showCalls).toBe(1);
	});

	test("runIssuerForTask aborts recovery when task is closed after initial issuer failure", async () => {
		const task: TaskIssue = { ...makeTask("task-closed-recovery"), status: "closed" };
		const initialRpc = new OmsRpcClient();
		const initialIssuer = makeIssuer(task.id, initialRpc, "issuer-task-closed-initial");
		initialIssuer.sessionId = "closed-session-1";
		let showCalls = 0;
		let spawnIssuerCalls = 0;
		let resumeAgentCalls = 0;

		(initialRpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd =
			async () => {
				throw new Error("issuer crashed");
			};

		const pipeline = new PipelineManager({
			tasksClient: {
				show: async () => {
					showCalls += 1;
					return task;
				},
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: () => [],
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnIssuer: async () => {
					spawnIssuerCalls += 1;
					return initialIssuer;
				},
				resumeAgent: async () => {
					resumeAgentCalls += 1;
					throw new Error("resumeAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});

		const result = await pipeline.runIssuerForTask(task);
		expect(result).toEqual({
			start: false,
			message: null,
			reason: "task closed during issuer execution",
			raw: null,
		});
		expect(showCalls).toBe(1);
		expect(spawnIssuerCalls).toBe(1);
		expect(resumeAgentCalls).toBe(0);
	});

	test("runIssuerForTask aborts recovery when task is blocked after initial issuer failure", async () => {
		const task: TaskIssue = { ...makeTask("task-blocked-recovery"), status: "blocked" };
		const initialRpc = new OmsRpcClient();
		const initialIssuer = makeIssuer(task.id, initialRpc, "issuer-task-blocked-initial");
		initialIssuer.sessionId = "blocked-session-1";
		let showCalls = 0;
		let spawnIssuerCalls = 0;
		let resumeAgentCalls = 0;

		(initialRpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd =
			async () => {
				throw new Error("issuer crashed");
			};

		const pipeline = new PipelineManager({
			tasksClient: {
				show: async () => {
					showCalls += 1;
					return task;
				},
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: () => [],
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnIssuer: async () => {
					spawnIssuerCalls += 1;
					return initialIssuer;
				},
				resumeAgent: async () => {
					resumeAgentCalls += 1;
					throw new Error("resumeAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});

		const result = await pipeline.runIssuerForTask(task);
		expect(result).toEqual({
			start: false,
			message: null,
			reason: "task blocked during issuer execution",
			raw: null,
		});
		expect(showCalls).toBe(1);
		expect(spawnIssuerCalls).toBe(1);
		expect(resumeAgentCalls).toBe(0);
	});

	test("runIssuerForTask aborts recovery when task is deleted after initial issuer failure", async () => {
		const task = makeTask("task-deleted-recovery");
		const initialRpc = new OmsRpcClient();
		const initialIssuer = makeIssuer(task.id, initialRpc, "issuer-task-deleted-initial");
		initialIssuer.sessionId = "deleted-session-1";
		let showCalls = 0;
		let spawnIssuerCalls = 0;
		let resumeAgentCalls = 0;

		(initialRpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd =
			async () => {
				throw new Error("issuer crashed");
			};

		const pipeline = new PipelineManager({
			tasksClient: {
				show: async () => {
					showCalls += 1;
					throw new Error("task not found");
				},
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: () => [],
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnIssuer: async () => {
					spawnIssuerCalls += 1;
					return initialIssuer;
				},
				resumeAgent: async () => {
					resumeAgentCalls += 1;
					throw new Error("resumeAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});

		const result = await pipeline.runIssuerForTask(task);
		expect(result).toEqual({
			start: false,
			message: null,
			reason: "task deleted during issuer execution",
			raw: null,
		});
		expect(showCalls).toBe(1);
		expect(spawnIssuerCalls).toBe(1);
		expect(resumeAgentCalls).toBe(0);
	});
});

describe("PipelineManager finisher lifecycle tracking", () => {
	const createLifecyclePipeline = () =>
		new PipelineManager({
			tasksClient: {
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: () => [],
				get: () => undefined,
			} as never,
			scheduler: {} as never,
			spawner: {} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});

	test("records and retrieves worker/issuer/block finisher advance decisions", () => {
		const pipeline = createLifecyclePipeline();
		const cases = [
			{ oldAction: "worker", action: "advance" as const, target: "worker" },
			{ oldAction: "issuer", action: "advance" as const, target: "issuer" },
			{ oldAction: "defer", action: "block" as const, target: null },
		];
		for (const { action, target } of cases) {
			const response = pipeline.advanceLifecycle({
				agentType: "finisher",
				taskId: "task-finish",
				action,
				target: target ?? undefined,
				message: `message-${action}`,
				reason: `reason-${action}`,
				agentId: "finisher-1",
			});
			expect(response).toMatchObject({ ok: true, action });

			const decision = pipeline.takeLifecycleRecord("task-finish");
			expect(decision).toMatchObject({
				taskId: "task-finish",
				agentType: "finisher",
				action,
				target: target ?? null,
				message: `message-${action}`,
				reason: `reason-${action}`,
				agentId: "finisher-1",
			});
			expect(pipeline.takeLifecycleRecord("task-finish")).toBeNull();
		}
	});

	test("rejects unsupported finisher advance action", () => {
		const pipeline = createLifecyclePipeline();
		const response = pipeline.advanceLifecycle({
			agentType: "finisher",
			taskId: "task-finish",
			action: "start",
		});
		expect(response).toEqual({
			ok: false,
			summary: "advance_lifecycle rejected: unsupported action 'start'",
		});
		expect(pipeline.takeLifecycleRecord("task-finish")).toBeNull();
	});

	test("records and retrieves speedy close markers via unified lifecycle", () => {
		const pipeline = createLifecyclePipeline();
		// First record an advance, then overwrite with a close
		pipeline.advanceLifecycle({
			agentType: "speedy",
			taskId: "task-fast",
			action: "advance",
			target: "finisher",
			message: "completed",
			reason: "ready",
			agentId: "fast-1",
		});
		pipeline.advanceLifecycle({
			agentType: "speedy",
			taskId: "task-fast",
			action: "close",
			reason: "done",
			agentId: "fast-1",
		});

		const record = pipeline.takeLifecycleRecord("task-fast");
		expect(record).toMatchObject({
			taskId: "task-fast",
			agentType: "speedy",
			action: "close",
			reason: "done",
			agentId: "fast-1",
		});
		expect(pipeline.takeLifecycleRecord("task-fast")).toBeNull();
	});
	test("records and retrieves finisher close markers", () => {
		const pipeline = createLifecyclePipeline();
		pipeline.advanceLifecycle({
			agentType: "finisher",
			taskId: "task-finish",
			action: "close",
			reason: "done",
			agentId: "finisher-1",
		});

		const closeRecord = pipeline.takeLifecycleRecord("task-finish");
		expect(closeRecord).toMatchObject({
			taskId: "task-finish",
			agentType: "finisher",
			action: "close",
			reason: "done",
			agentId: "finisher-1",
		});
		expect(pipeline.takeLifecycleRecord("task-finish")).toBeNull();
	});
});

describe("PipelineManager tiny-scope speedy routing", () => {
	const createTinyScopeFixture = (opts: {
		runSpeedyForTask: () => Promise<{
			done: boolean;
			escalate: boolean;
			closed: boolean;
			message: string | null;
			reason: string | null;
			raw: string | null;
		}>;
		runIssuerForTask?: (runOpts?: { kickoffMessage?: string }) => Promise<IssuerResult>;
		tryClaim?: boolean;
	}) => {
		const calls = {
			runSpeedyForTask: 0,
			runIssuerForTask: 0,
			spawnWorker: 0,
			spawnFinisher: 0,
			issuerKickoffs: [] as Array<string | undefined>,
			finisherOutputs: [] as string[],
		};
		const pipeline = new PipelineManager({
			tasksClient: {
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {} as never,
			scheduler: {
				tryClaim: async () => opts.tryClaim ?? true,
			} as never,
			spawner: {
				spawnAgent: async (configKey: string, taskId: string) => {
					if (configKey === "worker" || configKey === "designer" || configKey === "speedy") {
						calls.spawnWorker += 1;
						if (configKey === "designer") {
							return { ...makeWorker("designer"), agentType: "designer" } as never;
						}
					}
					return makeWorker(taskId);
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async (_taskId: string, workerOutput: string) => {
				calls.spawnFinisher += 1;
				calls.finisherOutputs.push(workerOutput);
				return {
					...makeWorker("finisher", `finisher:${Date.now()}`),
					agentType: "finisher",
				} as AgentInfo;
			},
			isRunning: () => true,
			isPaused: () => false,
		});

		(
			pipeline as unknown as {
				runSpeedyForTask: (task: TaskIssue) => Promise<{
					done: boolean;
					escalate: boolean;
					closed: boolean;
					message: string | null;
					reason: string | null;
					raw: string | null;
				}>;
			}
		).runSpeedyForTask = async () => {
			calls.runSpeedyForTask += 1;
			return await opts.runSpeedyForTask();
		};
		(
			pipeline as unknown as {
				runIssuerForTask: (task: TaskIssue, runOpts?: { kickoffMessage?: string }) => Promise<IssuerResult>;
			}
		).runIssuerForTask = async (_task, runOpts) => {
			calls.runIssuerForTask += 1;
			calls.issuerKickoffs.push(runOpts?.kickoffMessage);
			if (opts.runIssuerForTask) return await opts.runIssuerForTask(runOpts);
			return { start: true, message: null, reason: null, raw: null };
		};

		return { pipeline, calls };
	};

	test("tiny scope uses speedy done path and skips issuer/worker spawn", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runSpeedyForTask: async () => ({
				done: true,
				escalate: false,
				closed: false,
				message: "tiny change complete",
				reason: null,
				raw: "{}",
			}),
			runIssuerForTask: async () => {
				throw new Error("issuer should not run");
			},
		});
		const task: TaskIssue = { ...makeTask("tiny-done"), scope: "tiny" };

		await (pipeline as unknown as { runNewTaskPipeline: (task: TaskIssue) => Promise<void> }).runNewTaskPipeline(
			task,
		);

		expect(calls.runSpeedyForTask).toBe(1);
		expect(calls.runIssuerForTask).toBe(0);
		expect(calls.spawnWorker).toBe(0);
		expect(calls.spawnFinisher).toBe(1);
		expect(calls.finisherOutputs).toEqual(["tiny change complete"]);
	});

	test("tiny scope speedy close path skips issuer/worker/finisher spawn", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runSpeedyForTask: async () => ({
				done: true,
				escalate: false,
				closed: true,
				message: "closed directly",
				reason: null,
				raw: "{}",
			}),
			runIssuerForTask: async () => {
				throw new Error("issuer should not run");
			},
		});
		const task: TaskIssue = { ...makeTask("tiny-closed"), scope: "tiny" };

		await (pipeline as unknown as { runNewTaskPipeline: (task: TaskIssue) => Promise<void> }).runNewTaskPipeline(
			task,
		);

		expect(calls.runSpeedyForTask).toBe(1);
		expect(calls.runIssuerForTask).toBe(0);
		expect(calls.spawnWorker).toBe(0);
		expect(calls.spawnFinisher).toBe(0);
		expect(calls.finisherOutputs).toEqual([]);
	});

	test("tiny scope escalation falls through to issuer and spawns worker", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runSpeedyForTask: async () => ({
				done: false,
				escalate: true,
				closed: false,
				message: "touches broader lifecycle code",
				reason: "requires decomposition",
				raw: "{}",
			}),
			runIssuerForTask: async () => ({
				start: true,
				message: "issuer kickoff",
				reason: null,
				raw: "{}",
			}),
		});
		const task: TaskIssue = { ...makeTask("tiny-escalate"), scope: "tiny" };

		await (pipeline as unknown as { runNewTaskPipeline: (task: TaskIssue) => Promise<void> }).runNewTaskPipeline(
			task,
		);

		expect(calls.runSpeedyForTask).toBe(1);
		expect(calls.runIssuerForTask).toBe(1);
		expect(calls.spawnWorker).toBe(1);
		expect(calls.spawnFinisher).toBe(0);
		expect(calls.issuerKickoffs[0]).toContain("Fast-worker escalated this tiny task to full issuer lifecycle.");
		expect(calls.issuerKickoffs[0]).toContain("Reason: requires decomposition");
	});

	test("non-tiny scope keeps normal issuer path", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runSpeedyForTask: async () => {
				throw new Error("speedy should not run");
			},
			runIssuerForTask: async () => ({
				start: true,
				message: null,
				reason: null,
				raw: null,
			}),
		});
		const task: TaskIssue = { ...makeTask("small-normal"), scope: "small" };

		await (pipeline as unknown as { runNewTaskPipeline: (task: TaskIssue) => Promise<void> }).runNewTaskPipeline(
			task,
		);

		expect(calls.runSpeedyForTask).toBe(0);
		expect(calls.runIssuerForTask).toBe(1);
		expect(calls.spawnWorker).toBe(1);
		expect(calls.spawnFinisher).toBe(0);
	});
});

describe("PipelineManager pipelineInFlight ref-counting", () => {
	test("addPipelineInFlight is ref-counted: two adds require two removes", () => {
		const { pipeline } = createPipeline({});

		pipeline.addPipelineInFlight("task-1");
		expect(pipeline.isPipelineInFlight("task-1")).toBe(true);

		// Second add increments refcount
		pipeline.addPipelineInFlight("task-1");
		expect(pipeline.isPipelineInFlight("task-1")).toBe(true);

		// First remove decrements but does not clear
		pipeline.removePipelineInFlight("task-1");
		expect(pipeline.isPipelineInFlight("task-1")).toBe(true);

		// Second remove clears
		pipeline.removePipelineInFlight("task-1");
		expect(pipeline.isPipelineInFlight("task-1")).toBe(false);
	});

	test("removePipelineInFlight is safe when called more times than add", () => {
		const { pipeline } = createPipeline({});

		pipeline.addPipelineInFlight("task-1");
		pipeline.removePipelineInFlight("task-1");
		expect(pipeline.isPipelineInFlight("task-1")).toBe(false);

		// Extra remove should not throw or go negative
		pipeline.removePipelineInFlight("task-1");
		expect(pipeline.isPipelineInFlight("task-1")).toBe(false);
	});

	test("availableWorkerSlots counts ref-counted taskId as one slot", () => {
		const { pipeline } = createPipeline({});

		// Max workers = 1, no active workers, no reservations => 1 slot
		expect(pipeline.availableWorkerSlots()).toBe(1);

		// One add => 1 reserved => 0 slots
		pipeline.addPipelineInFlight("task-1");
		expect(pipeline.availableWorkerSlots()).toBe(0);

		// Second add for same taskId => still 1 reserved (Map has 1 key) => 0 slots
		pipeline.addPipelineInFlight("task-1");
		expect(pipeline.availableWorkerSlots()).toBe(0);

		// First remove => still in-flight => 0 slots
		pipeline.removePipelineInFlight("task-1");
		expect(pipeline.availableWorkerSlots()).toBe(0);

		// Second remove => cleared => 1 slot
		pipeline.removePipelineInFlight("task-1");
		expect(pipeline.availableWorkerSlots()).toBe(1);
	});

	test("independent taskIds are tracked separately", () => {
		const { pipeline } = createPipeline({});

		pipeline.addPipelineInFlight("task-a");
		pipeline.addPipelineInFlight("task-b");

		pipeline.removePipelineInFlight("task-a");
		expect(pipeline.isPipelineInFlight("task-a")).toBe(false);
		expect(pipeline.isPipelineInFlight("task-b")).toBe(true);

		pipeline.removePipelineInFlight("task-b");
		expect(pipeline.isPipelineInFlight("task-b")).toBe(false);
	});

	test("runNewTaskPipeline does not block when worker already active (replace_agent race)", async () => {
		const task = makeTask("task-race-new");
		const activeWorker = makeWorker(task.id, "worker:task-race-new:replacement");
		const statusCalls: Array<{ taskId: string; status: string }> = [];
		const pipeline = new PipelineManager({
			tasksClient: {
				updateStatus: async (taskId: string, status: string) => {
					statusCalls.push({ taskId, status });
				},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: (queryTaskId: string) => (queryTaskId === task.id ? [activeWorker] : []),
			} as never,
			scheduler: {
				tryClaim: async () => true,
			} as never,
			spawner: {
				spawnAgent: async () => {
					throw new Error("spawnAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [activeWorker],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});
		// Mock runIssuerForTask to return start=false (simulating issuer abort)
		(
			pipeline as unknown as {
				runIssuerForTask: (t: TaskIssue) => Promise<IssuerResult>;
			}
		).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: null,
			reason: "issuer stopped externally \u2014 pipeline replaced by singularity",
			raw: null,
		});
		await (
			pipeline as unknown as {
				runNewTaskPipeline: (task: TaskIssue) => Promise<void>;
			}
		).runNewTaskPipeline(task);
		// Task should NOT be blocked because worker is already active
		const blockedCalls = statusCalls.filter(c => c.status === "blocked");
		expect(blockedCalls).toEqual([]);
	});

	test("runResumePipeline does not block when worker already active (replace_agent race)", async () => {
		const task = makeTask("task-race-resume");
		const activeWorker = makeWorker(task.id, "worker:task-race-resume:replacement");
		const statusCalls: Array<{ taskId: string; status: string }> = [];
		const pipeline = new PipelineManager({
			tasksClient: {
				updateStatus: async (taskId: string, status: string) => {
					statusCalls.push({ taskId, status });
				},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: (queryTaskId: string) => (queryTaskId === task.id ? [activeWorker] : []),
			} as never,
			scheduler: {} as never,
			spawner: {
				spawnAgent: async () => {
					throw new Error("spawnAgent should not be called");
				},
			} as never,
			getMaxWorkers: () => 1,
			getActiveWorkerAgents: () => [activeWorker],
			loopLog: () => {},
			onDirty: () => {},
			wake: () => {},
			attachRpcHandlers: () => {},
			finishAgent: async () => {},
			logAgentStart: () => {},
			logAgentFinished: async () => {},
			hasPendingInterruptKickoff: () => false,
			takePendingInterruptKickoff: () => null,
			hasFinisherTakeover: () => false,
			spawnFinisherAfterStoppingSteering: async () => {
				throw new Error("Unexpected finisher spawn");
			},
			isRunning: () => true,
			isPaused: () => false,
		});
		// Mock runIssuerForTask to return action=block (simulating issuer abort)
		(
			pipeline as unknown as {
				runIssuerForTask: (t: TaskIssue) => Promise<IssuerResult>;
			}
		).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: null,
			reason: "issuer stopped externally \u2014 pipeline replaced by singularity",
			raw: null,
		});
		await (
			pipeline as unknown as {
				runResumePipeline: (task: TaskIssue) => Promise<void>;
			}
		).runResumePipeline(task);
		// Task should NOT be blocked because worker is already active
		const blockedCalls = statusCalls.filter(c => c.status === "blocked");
		expect(blockedCalls).toEqual([]);
	});
});
