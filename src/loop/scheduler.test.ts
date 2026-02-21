import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "../agents/registry";
import { createEmptyAgentUsage } from "../agents/types";
import { TaskCliError, type TaskStoreClient } from "../tasks/client";
import { closeIssue, createIssue } from "../tasks/store/core";
import { materializeIssue } from "../tasks/store/snapshot";
import { createEmptyStore } from "../tasks/store/utilities";
import type { TaskIssue } from "../tasks/types";
import { Scheduler } from "./scheduler";

function makeIssue(id: string, overrides: Partial<TaskIssue> = {}): TaskIssue {
	return {
		id,
		title: `Task ${id}`,
		description: null,
		acceptance_criteria: null,
		status: "open",
		priority: 2,
		issue_type: "task",
		labels: [],
		assignee: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function createFixture(opts?: {
	ready?: TaskIssue[];
	inProgress?: TaskIssue[];
	all?: TaskIssue[];
	byId?: Record<string, TaskIssue>;
	claim?: (taskId: string) => Promise<void>;
}) {
	const byId = opts?.byId ?? {};
	const tasksClient = {
		ready: async () => opts?.ready ?? [],
		list: async (args?: readonly string[]) => {
			if (Array.isArray(args) && args[0] === "--status" && args[1] === "in_progress") {
				return opts?.inProgress ?? [];
			}
			return opts?.all ?? [];
		},
		show: async (id: string) => {
			const issue = byId[id];
			if (!issue) throw new Error(`missing issue: ${id}`);
			return issue;
		},
		claim: async (taskId: string) => {
			if (opts?.claim) return await opts.claim(taskId);
		},
	} as unknown as TaskStoreClient;
	const registry = new AgentRegistry({ tasksClient });
	const scheduler = new Scheduler({ tasksClient, registry });
	return { scheduler, registry };
}

describe("Scheduler", () => {
	test("prioritizes ready tasks by priority then issue id", async () => {
		const { scheduler } = createFixture({
			ready: [
				makeIssue("task-10", { priority: 2 }),
				makeIssue("task-2", { priority: 1 }),
				makeIssue("task-1", { priority: 1 }),
			],
		});

		const next = await scheduler.getNextTasks(2);
		expect(next.map(task => task.id)).toEqual(["task-1", "task-2"]);
	});

	test("filters out ready tasks that already have active agents", async () => {
		const task = makeIssue("task-active", { priority: 1 });
		const { scheduler, registry } = createFixture({ ready: [task] });
		registry.register({
			id: "worker:task-active:1",
			agentType: "worker",
			taskId: "task-active",
			tasksAgentId: "agent-1",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: Date.now(),
			lastActivity: Date.now(),
		});

		const next = await scheduler.getNextTasks(1);
		expect(next).toEqual([]);
	});

	test("blocks tasks with non-closed blocking dependencies", async () => {
		const task = makeIssue("task-1", { depends_on_ids: ["dep-1"] });
		const { scheduler } = createFixture({
			ready: [task],
			byId: {
				"dep-1": makeIssue("dep-1", { status: "open" }),
			},
		});

		const next = await scheduler.getNextTasks(1);
		expect(next).toEqual([]);
	});

	test("treats parent-child dependencies as blocking when scheduling", async () => {
		const task = makeIssue("task-1", {
			dependencies: [{ depends_on_id: "parent-1", status: "open", type: "parent-child" }],
		});
		const { scheduler } = createFixture({ ready: [task] });

		const next = await scheduler.getNextTasks(1);
		expect(next).toEqual([]);
	});

	test("uses detailed show when dependency_count is present without refs", async () => {
		const listTask = makeIssue("task-1", { dependency_count: 1 });
		const detailedTask = makeIssue("task-1", { depends_on_ids: ["dep-closed"] });
		const { scheduler } = createFixture({
			ready: [listTask],
			byId: {
				"task-1": detailedTask,
				"dep-closed": makeIssue("dep-closed", { status: "closed" }),
			},
		});

		const next = await scheduler.getNextTasks(1);
		expect(next.map(issue => issue.id)).toEqual(["task-1"]);
	});

	test("filters out tasks that conflict with in-progress labels", async () => {
		const { scheduler } = createFixture({
			ready: [makeIssue("task-1", { labels: ["module:ipc"] })],
			inProgress: [makeIssue("task-2", { status: "in_progress", labels: ["module:ipc"] })],
		});

		const next = await scheduler.getNextTasks(1);
		expect(next).toEqual([]);
	});

	test("returns in-progress tasks without active agents sorted by priority", async () => {
		const taskA = makeIssue("task-a", { status: "in_progress", priority: 3 });
		const taskB = makeIssue("task-b", { status: "in_progress", priority: 1 });
		const { scheduler, registry } = createFixture({ inProgress: [taskA, taskB] });
		registry.register({
			id: "worker:task-a:1",
			agentType: "worker",
			taskId: "task-a",
			tasksAgentId: "agent-task-a",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: Date.now(),
			lastActivity: Date.now(),
		});

		const next = await scheduler.getInProgressTasksWithoutAgent(2);
		expect(next.map(task => task.id)).toEqual(["task-b"]);
	});

	test("tryClaim returns false for already-claimed races", async () => {
		const { scheduler } = createFixture({
			claim: async () => {
				throw new TaskCliError({
					message: "already claimed",
					cmd: ["tasks", "update"],
					cwd: process.cwd(),
					exitCode: 1,
					stdout: "",
					stderr: "issue already claimed by oms-worker",
				});
			},
		});

		expect(await scheduler.tryClaim("task-1")).toBe(false);
	});

	test("tryClaim rethrows non-race claim errors", async () => {
		const { scheduler } = createFixture({
			claim: async () => {
				throw new Error("permission denied");
			},
		});

		expect(scheduler.tryClaim("task-1")).rejects.toThrow("permission denied");
	});

	test("findTasksUnblockedBy returns tasks whose dependencies became satisfied", async () => {
		const taskA = makeIssue("task-a", { status: "closed" });
		const blockedB = makeIssue("task-b", { depends_on_ids: ["task-a"] });
		const blockedC = makeIssue("task-c", { depends_on_ids: ["task-b"], status: "open" });
		const { scheduler } = createFixture({
			all: [blockedB, blockedC],
			byId: {
				"task-a": taskA,
				"task-b": blockedB,
				"task-c": blockedC,
			},
		});

		const result = await scheduler.findTasksUnblockedBy("task-a");
		expect(result.map(task => task.id)).toEqual(["task-b"]);
	});

	test("findTasksUnblockedBy returns dependent after closeIssue refreshes cached dependency status", async () => {
		const state = createEmptyStore();
		const blocker = createIssue(state, "oms-test", "Blocker task");
		const dependent = createIssue(state, "oms-test", "Dependent task", null, undefined, {
			depends_on: blocker.id,
		});
		closeIssue(state, "oms-test", blocker.id, "done");

		const blockerIssue = materializeIssue(state.issues[blocker.id]!, state);
		const dependentIssue = materializeIssue(state.issues[dependent.id]!, state);
		const { scheduler } = createFixture({
			all: [dependentIssue],
			byId: {
				[blocker.id]: blockerIssue,
				[dependent.id]: dependentIssue,
			},
		});

		const result = await scheduler.findTasksUnblockedBy(blocker.id);
		expect(result.map(task => task.id)).toEqual([dependent.id]);
	});
});
