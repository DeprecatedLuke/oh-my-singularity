import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { PipelineManager } from "./pipeline";

type ActiveWorkerProvider = () => AgentInfo[];

type ResumeDecision = {
	action: "start" | "skip" | "defer";
	message: string | null;
	reason: string | null;
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

const createPipeline = (opts: {
	activeWorkers?: ActiveWorkerProvider;
	runResumeSteering: () => Promise<ResumeDecision>;
	spawnWorker?: (task: TaskIssue, claim?: boolean, kickoffMessage?: string | null) => Promise<AgentInfo>;
}) => {
	const calls = {
		runResumeSteering: 0,
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
		runResumeSteering: async () => {
			calls.runResumeSteering += 1;
			return opts.runResumeSteering();
		},
		hasFinisherTakeover: () => false,
		spawnFinisherAfterStoppingSteering: async () => {
			throw new Error("Unexpected finisher spawn");
		},
		isRunning: () => true,
		isPaused: () => false,
	});
	return { pipeline, calls, activeWorkers };
};

describe("PipelineManager resume pipeline", () => {
	test("runResumePipeline skips worker spawn when an active worker already exists", async () => {
		const task = makeTask("task-1");
		const activeWorker = makeWorker(task.id, "worker-existing");
		const { pipeline, calls } = createPipeline({
			activeWorkers: () => [activeWorker],
			runResumeSteering: async () => ({ action: "start", message: "resume", reason: null }),
			spawnWorker: async () => {
				throw new Error("unreachable");
			},
		});

		await (pipeline as unknown as { runResumePipeline: (task: TaskIssue) => Promise<void> }).runResumePipeline(task);
		expect(calls.runResumeSteering).toBe(1);
		expect(calls.spawnWorker).toBe(0);
	});
});
