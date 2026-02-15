import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { PipelineManager } from "../loop/pipeline";
import type { SteeringManager } from "../loop/steering";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import type { SideEffect } from "../types/workflow-engine";
import { WorkflowEngine } from "./workflow-engine";

function makeTask(id: string): TaskIssue {
	return {
		id,
		title: "Test task",
		description: "Test description",
		status: "pending",
	} as TaskIssue;
}

function makeAgent(id: string): AgentInfo {
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
	};
}

describe("WorkflowEngine", () => {
	let engine: WorkflowEngine;
	let pipelineManager: any;
	let steeringManager: any;
	let tasksClient: any;
	let spawner: any;

	let taskClientCalls: {
		comments: Array<{ taskId: string; text: string }>;
		statusUpdates: Array<{ taskId: string; status: string }>;
	};

	let agentSpawns: Array<{ role: string; taskId: string }>;
	let rpcHandlerCalls: string[];

	beforeEach(() => {
		taskClientCalls = { comments: [], statusUpdates: [] };
		agentSpawns = [];
		rpcHandlerCalls = [];

		tasksClient = {
			comment: async (taskId: string, text: string) => {
				taskClientCalls.comments.push({ taskId, text });
			},
			updateStatus: async (taskId: string, status: string) => {
				taskClientCalls.statusUpdates.push({ taskId, status });
			},
		};

		pipelineManager = {
			runIssuerForTask: async () => ({
				start: true,
				message: "Ready",
				reason: null,
				raw: null,
			}),
			spawnTaskWorker: async (task: TaskIssue) => {
				agentSpawns.push({ role: "worker", taskId: task.id });
				return makeAgent("worker:task-1");
			},
		};

		steeringManager = {
			spawnFinisherAfterStoppingSteering: async (taskId: string) => {
				agentSpawns.push({ role: "finisher", taskId });
				return makeAgent("finisher:task-1");
			},
		};

		spawner = {
			spawnSteering: async (taskId: string) => {
				agentSpawns.push({ role: "steering", taskId });
				return makeAgent("steering:task-1");
			},
		};

		engine = new WorkflowEngine(
			pipelineManager as unknown as PipelineManager,
			steeringManager as unknown as SteeringManager,
			tasksClient as unknown as TaskStoreClient,
			spawner as unknown as AgentSpawner,
			(agent: AgentInfo) => {
				rpcHandlerCalls.push(agent.id);
			},
		);
	});

	test("dispatchAgent routes scout role to issuer strategy", async () => {
		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("scout", task);

		expect(result.success).toBe(true);
		expect(agentSpawns).toContainEqual({ role: "worker", taskId: "task-1" });
	});

	test("dispatchAgent routes worker role to worker spawn strategy", async () => {
		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("worker", task);

		expect(result.success).toBe(true);
		expect(agentSpawns).toContainEqual({ role: "worker", taskId: "task-1" });
	});

	test("dispatchAgent routes finisher role to verifier strategy", async () => {
		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("finisher", task);

		expect(result.success).toBe(true);
		expect(agentSpawns).toContainEqual({ role: "finisher", taskId: "task-1" });
	});

	test("dispatchAgent routes steering role to supervisor strategy", async () => {
		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("steering", task);

		expect(result.success).toBe(true);
		expect(agentSpawns).toContainEqual({ role: "steering", taskId: "task-1" });
	});

	test("dispatchAgent executes side effects from successful dispatch", async () => {
		// Setup scout to defer
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: "Waiting",
			reason: "Dependencies",
			raw: null,
		});

		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("scout", task);

		expect(result.success).toBe(true);
		// Verify side effects were returned
		expect(result.sideEffects.length).toBeGreaterThan(0);
		// Verify comment side effect was executed
		expect(taskClientCalls.comments.length).toBeGreaterThan(0);
		expect(result.success).toBe(true);
		// Verify side effects were returned from the strategy
		expect(result.sideEffects.length).toBeGreaterThan(0);
		// Verify comment side effect was executed
		expect(taskClientCalls.comments.length).toBeGreaterThan(0);
	});

	test("dispatchAgent handles side effect errors non-fatally", async () => {
		// Setup scout to skip
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: true,
			message: null,
			reason: "Complete",
			raw: null,
		});

		// Make comment fail
		(tasksClient as any).comment = async () => {
			throw new Error("Comment failed");
		};

		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("scout", task);

		// Should still succeed even though side effect failed
		expect(result.success).toBe(true);
	});

	test("stopSupervisors delegates to SteeringManager", async () => {
		const calls: string[] = [];
		(steeringManager as any).stopSupervisors = async (taskId: string) => {
			calls.push(taskId);
		};

		await engine.stopSupervisors("task-1");
		expect(calls).toContain("task-1");
	});

	test("executeSideEffects processes all effect types", async () => {
		const effects: SideEffect[] = [
			{
				type: "post_comment",
				taskId: "task-1",
				text: "Test comment",
			},
			{
				type: "update_task_status",
				taskId: "task-1",
				status: "active",
			},
		];

		await engine.executeSideEffects(effects);

		expect(taskClientCalls.comments).toHaveLength(1);
		const comment = taskClientCalls.comments[0]!;
		expect(comment.text).toBe("Test comment");
		expect(taskClientCalls.statusUpdates).toHaveLength(1);
		const status = taskClientCalls.statusUpdates[0]!;
		expect(status.status).toBe("active");
		expect(taskClientCalls.comments[0]!.text).toBe("Test comment");
		expect(taskClientCalls.statusUpdates).toHaveLength(1);
		expect(taskClientCalls.statusUpdates[0]!.status).toBe("active");
		expect(taskClientCalls.statusUpdates).toHaveLength(1);
		expect(taskClientCalls.statusUpdates[0]!.status).toBe("active");
	});

	test("executeSideEffects handles empty effects gracefully", async () => {
		await engine.executeSideEffects([]);
		expect(taskClientCalls.comments).toHaveLength(0);
		expect(taskClientCalls.statusUpdates).toHaveLength(0);
	});

	test("executeSideEffects maintains execution order even with errors", async () => {
		const executionOrder: string[] = [];

		(tasksClient as any).comment = async () => {
			executionOrder.push("comment");
			throw new Error("Comment failed");
		};
		(tasksClient as any).updateStatus = async () => {
			executionOrder.push("status");
		};

		const effects: SideEffect[] = [
			{
				type: "post_comment",
				taskId: "task-1",
				text: "Comment",
			},
			{
				type: "update_task_status",
				taskId: "task-1",
				status: "active",
			},
		];

		await engine.executeSideEffects(effects);

		expect(executionOrder).toEqual(["comment", "status"]);
	});

	test("executeSideEffects spawns follow-up agents", async () => {
		const effects: SideEffect[] = [
			{
				type: "spawn_followup",
				taskId: "task-1",
				agentRole: "worker",
			},
		];

		await engine.executeSideEffects(effects);

		expect(agentSpawns).toContainEqual({ role: "worker", taskId: "task-1" });
	});
});
