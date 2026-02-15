import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { TaskIssue } from "../tasks/types";
import type { PostComment, SpawnFollowUp, UpdateTaskStatus } from "../types/workflow-engine";
import { DirectSpawnStrategy, RunScoutCycleStrategy, StopSupervisorsThenSpawnStrategy } from "./dispatch-strategies";

function makeTask(id: string, overrides: Partial<TaskIssue> = {}): TaskIssue {
	return {
		id,
		title: "Test task",
		description: "Test description",
		status: "pending",
		...overrides,
	} as TaskIssue;
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

describe("RunScoutCycleStrategy", () => {
	let issuerCalls: Array<{ task: TaskIssue; opts?: { kickoffMessage?: string } }>;

	beforeEach(() => {
		issuerCalls = [];
	});

	test("returns skip with finisher spawn and comment when issuer skips", async () => {
		const runIssuerForTask = async (task: TaskIssue, opts?: { kickoffMessage?: string }) => {
			issuerCalls.push({ task, opts });
			return {
				start: false,
				skip: true,
				message: "Task completed in issue review",
				reason: "No implementation work needed",
				raw: null,
			};
		};

		const strategy = new RunScoutCycleStrategy(runIssuerForTask);
		const task = makeTask("task-1");
		const result = await strategy.execute(task, { context: "test context" });

		expect(result.success).toBe(true);
		expect(result.message).toContain("Issuer skip");
		expect(result.reason).toBe("No implementation work needed");
		expect(issuerCalls).toHaveLength(1);
		expect(issuerCalls[0]!.opts?.kickoffMessage).toBe("test context");
		expect(issuerCalls[0]!.opts?.kickoffMessage).toBe("test context");

		// Verify side effects
		expect(result.sideEffects).toHaveLength(2);
		const comment = result.sideEffects[0] as PostComment;
		expect(comment.type).toBe("post_comment");
		expect(comment.text).toContain("Issuer skip");

		const spawn = result.sideEffects[1] as SpawnFollowUp;
		expect(spawn.type).toBe("spawn_followup");
		expect(spawn.agentRole).toBe("finisher");
		expect(spawn.taskId).toBe("task-1");
	});

	test("returns defer with status update and comment when issuer defers", async () => {
		const runIssuerForTask = async () => {
			return {
				start: false,
				skip: false,
				message: "Waiting for dependencies",
				reason: "Cannot start yet",
				raw: null,
			};
		};

		const strategy = new RunScoutCycleStrategy(runIssuerForTask);
		const task = makeTask("task-1");
		const result = await strategy.execute(task);

		expect(result.success).toBe(true);
		expect(result.message).toContain("Issuer deferred");
		expect(result.reason).toBe("Cannot start yet");

		// Verify side effects: comment and status update (no spawn)
		expect(result.sideEffects).toHaveLength(2);
		const comment = result.sideEffects[0] as PostComment;
		expect(comment.type).toBe("post_comment");
		expect(comment.text).toContain("Issuer deferred");

		const status = result.sideEffects[1] as UpdateTaskStatus;
		expect(status.type).toBe("update_task_status");
		expect(status.status).toBe("blocked");
		expect(status.taskId).toBe("task-1");
	});

	test("returns start with implementer spawn when issuer starts", async () => {
		const runIssuerForTask = async () => {
			return {
				start: true,
				skip: false,
				message: "Ready to implement",
				reason: null,
				raw: null,
			};
		};

		const strategy = new RunScoutCycleStrategy(runIssuerForTask);
		const task = makeTask("task-1");
		const result = await strategy.execute(task, { context: "implementation notes" });

		expect(result.success).toBe(true);
		expect(result.message).toContain("Issuer started worker");

		// Verify side effects: only spawn (no comment or status)
		expect(result.sideEffects).toHaveLength(1);
		const spawn = result.sideEffects[0] as SpawnFollowUp;
		expect(spawn.type).toBe("spawn_followup");
		expect(spawn.agentRole).toBe("implementer");
		expect(spawn.taskId).toBe("task-1");
		// Context comes from issuer's message, not from opts.context
		expect(spawn.context).toBe("Ready to implement");
	});

	test("handles issuer errors gracefully", async () => {
		const runIssuerForTask = async () => {
			throw new Error("Issuer crashed");
		};

		const strategy = new RunScoutCycleStrategy(runIssuerForTask);
		const task = makeTask("task-1");
		const result = await strategy.execute(task);

		expect(result.success).toBe(false);
		expect(result.reason).toBe("Issuer crashed");
		expect(result.sideEffects).toEqual([]);
	});
});

describe("StopSupervisorsThenSpawnStrategy", () => {
	let spawnCalls: Array<{ taskId: string; workerOutput: string }>;

	beforeEach(() => {
		spawnCalls = [];
	});

	test("stops supervisors and spawns finisher with output", async () => {
		const finisher = makeAgent("finisher:task-1", { role: "finisher" });
		const spawnFinisherAfterStoppingSteering = async (taskId: string, workerOutput: string) => {
			spawnCalls.push({ taskId, workerOutput });
			return finisher;
		};

		const strategy = new StopSupervisorsThenSpawnStrategy(spawnFinisherAfterStoppingSteering);
		const task = makeTask("task-1");
		const result = await strategy.execute(task, { context: "worker output here" });

		expect(result.success).toBe(true);
		expect(result.agent).toEqual(finisher);
		expect(result.message).toContain("Finisher spawned");
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]!.taskId).toBe("task-1");
		expect(spawnCalls[0]!.workerOutput).toBe("worker output here");
		expect(spawnCalls[0]!.taskId).toBe("task-1");
		expect(spawnCalls[0]!.workerOutput).toBe("worker output here");

		// Verify side effects: only comment
		expect(result.sideEffects).toHaveLength(1);
		const comment = result.sideEffects[0] as PostComment;
		expect(comment.type).toBe("post_comment");
		expect(comment.text).toContain("Finisher spawned");
	});

	test("uses default message when context not provided", async () => {
		const finisher = makeAgent("finisher:task-1", { role: "finisher" });
		const spawnFinisherAfterStoppingSteering = async (_taskId: string, workerOutput: string) => {
			expect(workerOutput).toContain("lifecycle recovery");
			return finisher;
		};

		const strategy = new StopSupervisorsThenSpawnStrategy(spawnFinisherAfterStoppingSteering);
		const task = makeTask("task-1");
		const result = await strategy.execute(task);

		expect(result.success).toBe(true);
		expect(result.agent).toEqual(finisher);
	});

	test("handles spawn errors gracefully", async () => {
		const spawnFinisherAfterStoppingSteering = async () => {
			throw new Error("Cannot spawn finisher");
		};

		const strategy = new StopSupervisorsThenSpawnStrategy(spawnFinisherAfterStoppingSteering);
		const task = makeTask("task-1");
		const result = await strategy.execute(task);

		expect(result.success).toBe(false);
		expect(result.reason).toBe("Cannot spawn finisher");
		expect(result.sideEffects).toEqual([]);
	});
});

describe("DirectSpawnStrategy", () => {
	let spawnCalls: Array<{ task: TaskIssue; opts?: { claim?: boolean; kickoffMessage?: string | null } }>;

	beforeEach(() => {
		spawnCalls = [];
	});

	test("spawns implementer with claim flag", async () => {
		const worker = makeAgent("worker:task-1", { role: "worker" });
		const spawn = async (task: TaskIssue, opts?: { claim?: boolean; kickoffMessage?: string | null }) => {
			spawnCalls.push({ task, opts });
			return worker;
		};

		const strategy = new DirectSpawnStrategy(spawn, false);
		const task = makeTask("task-1");
		const result = await strategy.execute(task, { context: "task details" });

		expect(result.success).toBe(true);
		expect(result.agent).toEqual(worker);
		expect(result.message).toContain("Worker spawned");
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]!.opts?.claim).toBe(true);
		expect(spawnCalls[0]!.opts?.kickoffMessage).toBe("task details");
		expect(spawnCalls[0]!.opts?.claim).toBe(true);
		expect(spawnCalls[0]!.opts?.kickoffMessage).toBe("task details");

		// Verify side effects: only comment
		expect(result.sideEffects).toHaveLength(1);
		const comment = result.sideEffects[0] as PostComment;
		expect(comment.type).toBe("post_comment");
		expect(comment.text).toContain("Agent spawned");
	});

	test("spawns supervisor without claim flag", async () => {
		const supervisor = makeAgent("steering:task-1", { role: "steering" });
		const spawn = async (_task: TaskIssue, opts?: { claim?: boolean }) => {
			expect(opts?.claim).toBe(false);
			return supervisor;
		};

		const strategy = new DirectSpawnStrategy(spawn, true);
		const task = makeTask("task-1");
		const result = await strategy.execute(task);

		expect(result.success).toBe(true);
		expect(result.agent).toEqual(supervisor);
		expect(result.message).toContain("Supervisor spawned");
	});

	test("handles spawn errors gracefully", async () => {
		const spawn = async () => {
			throw new Error("Cannot spawn agent");
		};

		const strategy = new DirectSpawnStrategy(spawn);
		const task = makeTask("task-1");
		const result = await strategy.execute(task);

		expect(result.success).toBe(false);
		expect(result.reason).toBe("Cannot spawn agent");
		expect(result.sideEffects).toEqual([]);
	});

	test("uses undefined for missing context", async () => {
		let capturedOpts: { claim?: boolean; kickoffMessage?: string | null } | undefined;
		const spawn = async (_task: TaskIssue, opts?: { claim?: boolean; kickoffMessage?: string | null }) => {
			capturedOpts = opts;
			return makeAgent("worker:task-1");
		};

		const strategy = new DirectSpawnStrategy(spawn);
		await strategy.execute(makeTask("task-1"));

		expect(capturedOpts?.kickoffMessage).toBe(undefined);
	});
});
