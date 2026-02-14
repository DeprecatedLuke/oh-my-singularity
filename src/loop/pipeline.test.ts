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
	});
});
