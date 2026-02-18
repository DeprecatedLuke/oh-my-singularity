import { describe, expect, test } from "bun:test";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { PipelineManager } from "./pipeline";

type ActiveWorkerProvider = () => AgentInfo[];

type IssuerResult = {
	start: boolean;
	skip?: boolean;
	message: string | null;
	reason: string | null;
	raw: string | null;
};

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
	role: "worker",
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
	role: "issuer",
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
			spawnWorker: async (taskId: string) => {
				calls.spawnWorker += 1;
				if (opts.spawnWorker) {
					return opts.spawnWorker(makeTask(taskId), false, undefined);
				}
				return makeWorker(taskId);
			},
			spawnDesignerWorker: async () =>
				({
					...makeWorker("designer"),
					role: "designer-worker",
				}) as never,
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
	test("runIssuerForTask treats wait failure as success when advance_lifecycle already recorded", async () => {
		const task = makeTask("task-advance");
		const rpc = new OmsRpcClient();
		const issuer = makeIssuer(task.id, rpc, "issuer-task-advance");
		const finishCalls: Array<{ id: string; status: "done" | "stopped" | "dead" }> = [];
		const logFinishedCalls: string[] = [];
		let spawnIssuerCalls = 0;
		let resumeAgentCalls = 0;
		let forceKillCalls = 0;
		let pipeline: PipelineManager;

		(rpc as unknown as { forceKill: () => void }).forceKill = () => {
			forceKillCalls += 1;
		};

		(rpc as unknown as { getLastAssistantText: () => Promise<string | null> }).getLastAssistantText = async () =>
			"advance completed";

		(rpc as unknown as { waitForAgentEnd: (_timeoutMs?: number) => Promise<void> }).waitForAgentEnd = async () => {
			pipeline.advanceIssuerLifecycle({
				taskId: task.id,
				action: "start",
				message: "ship it",
				reason: "ready",
				agentId: issuer.id,
			});
			throw new Error("RPC process exited before agent_end");
		};

		pipeline = new PipelineManager({
			tasksClient: {
				updateStatus: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient,
			registry: {
				getActiveByTask: (queryTaskId: string) => (queryTaskId === task.id ? [issuer] : []),
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
			action: "start",
			message: "ship it",
			reason: "ready",
			agentId: issuer.id,
		});
		expect(spawnIssuerCalls).toBe(1);
		expect(resumeAgentCalls).toBe(0);
		expect(forceKillCalls).toBe(1);
		expect(finishCalls).toEqual([{ id: issuer.id, status: "done" }]);
		expect(logFinishedCalls).toEqual(["advance completed"]);
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
				pipeline.advanceIssuerLifecycle({
					taskId: task.id,
					action: "start",
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
		expect(resumeKickoff).toContain("[SYSTEM RESUME]");
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

	test("records and retrieves worker/issuer/defer finisher advance decisions", () => {
		const pipeline = createLifecyclePipeline();
		for (const action of ["worker", "issuer", "defer"] as const) {
			const response = pipeline.advanceFinisherLifecycle({
				taskId: "task-finish",
				action,
				message: `message-${action}`,
				reason: `reason-${action}`,
				agentId: "finisher-1",
			});
			expect(response).toMatchObject({ ok: true, action });

			const decision = pipeline.takeFinisherLifecycleAdvance("task-finish");
			expect(decision).toMatchObject({
				taskId: "task-finish",
				action,
				message: `message-${action}`,
				reason: `reason-${action}`,
				agentId: "finisher-1",
			});
			expect(pipeline.takeFinisherLifecycleAdvance("task-finish")).toBeNull();
		}
	});

	test("rejects unsupported finisher advance action", () => {
		const pipeline = createLifecyclePipeline();
		const response = pipeline.advanceFinisherLifecycle({
			taskId: "task-finish",
			action: "start",
		});
		expect(response).toEqual({
			ok: false,
			summary: "advance_lifecycle rejected: unsupported action 'start'",
		});
		expect(pipeline.takeFinisherLifecycleAdvance("task-finish")).toBeNull();
	});

	test("records and retrieves finisher close markers", () => {
		const pipeline = createLifecyclePipeline();
		pipeline.recordFinisherClose({ taskId: "task-finish", reason: "done", agentId: "finisher-1" });

		const closeRecord = pipeline.takeFinisherCloseRecord("task-finish");
		expect(closeRecord).toMatchObject({
			taskId: "task-finish",
			reason: "done",
			agentId: "finisher-1",
		});
		expect(pipeline.takeFinisherCloseRecord("task-finish")).toBeNull();
	});
});

describe("PipelineManager tiny-scope fast-worker routing", () => {
	const createTinyScopeFixture = (opts: {
		runFastWorkerForTask: () => Promise<{
			done: boolean;
			escalate: boolean;
			message: string | null;
			reason: string | null;
			raw: string | null;
		}>;
		runIssuerForTask?: (runOpts?: { kickoffMessage?: string }) => Promise<IssuerResult>;
		tryClaim?: boolean;
	}) => {
		const calls = {
			runFastWorkerForTask: 0,
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
				spawnWorker: async (taskId: string) => {
					calls.spawnWorker += 1;
					return makeWorker(taskId);
				},
				spawnDesignerWorker: async () =>
					({
						...makeWorker("designer"),
						role: "designer-worker",
					}) as never,
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
					role: "finisher",
				} as AgentInfo;
			},
			isRunning: () => true,
			isPaused: () => false,
		});

		(
			pipeline as unknown as {
				runFastWorkerForTask: (task: TaskIssue) => Promise<{
					done: boolean;
					escalate: boolean;
					message: string | null;
					reason: string | null;
					raw: string | null;
				}>;
			}
		).runFastWorkerForTask = async () => {
			calls.runFastWorkerForTask += 1;
			return await opts.runFastWorkerForTask();
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

	test("tiny scope uses fast-worker done path and skips issuer/worker spawn", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runFastWorkerForTask: async () => ({
				done: true,
				escalate: false,
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

		expect(calls.runFastWorkerForTask).toBe(1);
		expect(calls.runIssuerForTask).toBe(0);
		expect(calls.spawnWorker).toBe(0);
		expect(calls.spawnFinisher).toBe(1);
		expect(calls.finisherOutputs).toEqual(["tiny change complete"]);
	});

	test("tiny scope escalation falls through to issuer and spawns worker", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runFastWorkerForTask: async () => ({
				done: false,
				escalate: true,
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

		expect(calls.runFastWorkerForTask).toBe(1);
		expect(calls.runIssuerForTask).toBe(1);
		expect(calls.spawnWorker).toBe(1);
		expect(calls.spawnFinisher).toBe(0);
		expect(calls.issuerKickoffs[0]).toContain("Fast-worker escalated this tiny task to full issuer lifecycle.");
		expect(calls.issuerKickoffs[0]).toContain("Reason: requires decomposition");
	});

	test("non-tiny scope keeps normal issuer path", async () => {
		const { pipeline, calls } = createTinyScopeFixture({
			runFastWorkerForTask: async () => {
				throw new Error("fast-worker should not run");
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

		expect(calls.runFastWorkerForTask).toBe(0);
		expect(calls.runIssuerForTask).toBe(1);
		expect(calls.spawnWorker).toBe(1);
		expect(calls.spawnFinisher).toBe(0);
	});
});
