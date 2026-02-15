import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentRegistry } from "../agents/registry";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { PipelineManager } from "../loop/pipeline";
import type { SteeringManager } from "../loop/steering";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { InteractiveWorkflowEngine } from "./interactive-workflow";

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

describe("InteractiveWorkflowEngine", () => {
	let engine: InteractiveWorkflowEngine;
	let pipelineManager: any;
	let steeringManager: any;
	let registry: any;
	let tasksClient: any;
	let spawner: any;
	let sideEffectsExecuted: string[];

	beforeEach(() => {
		sideEffectsExecuted = [];

		tasksClient = {
			comment: async () => {
				sideEffectsExecuted.push("comment");
			},
			updateStatus: async () => {
				sideEffectsExecuted.push("status");
			},
		};

		pipelineManager = {
			runIssuerForTask: async () => ({
				start: true,
				message: "Ready",
				reason: null,
				raw: null,
			}),
			spawnTaskWorker: async () => makeAgent("worker:task-1"),
		};

		steeringManager = {
			spawnFinisherAfterStoppingSteering: async () => makeAgent("finisher:task-1"),
		};

		registry = {} as unknown as AgentRegistry;

		spawner = {
			spawnSteering: async () => makeAgent("steering:task-1"),
		};

		engine = new InteractiveWorkflowEngine(
			pipelineManager as unknown as PipelineManager,
			steeringManager as unknown as SteeringManager,
			registry as unknown as AgentRegistry,
			tasksClient as unknown as TaskStoreClient,
			spawner as unknown as AgentSpawner,
		);
	});

	test("queues side effects for manual approval after execution", async () => {
		// Note: In current implementation, InteractiveWorkflowEngine queues effects
		// AFTER they've been executed by base class. This is captured for review.
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: true,
			message: null,
			reason: "Complete",
			raw: null,
		});

		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("scout", task);

		expect(result.success).toBe(true);

		// Effects are executed by base class and also queued for interactive review
		expect(sideEffectsExecuted.length).toBeGreaterThan(0);

		// Verify effects are queued
		const pending = engine.getPendingSideEffects("task-1");
		expect(pending.length).toBeGreaterThan(0);
	});

	test("getPendingSideEffects returns queued effects for task", async () => {
		const task = makeTask("task-1");

		// Setup issuer to defer (generates comment + status)
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: "Waiting",
			reason: "Dependencies",
			raw: null,
		});

		await engine.dispatchAgent("scout", task);

		const pending = engine.getPendingSideEffects("task-1");

		// Should have comment effect queued
		expect(pending.length).toBeGreaterThan(0);
		expect(pending[0]!.type).toBe("post_comment");
	});

	test("getPendingSideEffects returns empty array for unknown task", async () => {
		const pending = engine.getPendingSideEffects("unknown-task");
		expect(pending).toEqual([]);
	});

	test("approveSideEffects executes queued effects again", async () => {
		const task = makeTask("task-1");
		sideEffectsExecuted = [];

		// Setup issuer to defer (generates comment + status)
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: "Waiting",
			reason: "Dependencies",
			raw: null,
		});

		await engine.dispatchAgent("scout", task);

		// Verify effects were already executed
		const executedCountAfterDispatch = sideEffectsExecuted.length;
		expect(executedCountAfterDispatch).toBeGreaterThan(0);

		// Get initial count
		sideEffectsExecuted = [];

		// Verify effects are queued
		let pending = engine.getPendingSideEffects("task-1");
		expect(pending.length).toBeGreaterThan(0);

		// Approve side effects - executes them again
		await engine.approveSideEffects("task-1");

		// Verify effects were executed again
		expect(sideEffectsExecuted.length).toBeGreaterThan(0);

		// Verify queue is cleared after approval
		pending = engine.getPendingSideEffects("task-1");
		expect(pending).toHaveLength(0);
	});

	test("approveSideEffects handles missing task gracefully", async () => {
		// Should not throw, just warn
		await engine.approveSideEffects("unknown-task");

		// Should still have no issues
		expect(sideEffectsExecuted.length).toBe(0);
	});

	test("rejectSideEffects clears queued effects without additional execution", async () => {
		const task = makeTask("task-1");
		sideEffectsExecuted = [];

		// Setup issuer to defer (generates comment + status)
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: "Waiting",
			reason: "Dependencies",
			raw: null,
		});

		await engine.dispatchAgent("scout", task);

		// Record count after dispatch (effects already executed once)
		const _countAfterDispatch = sideEffectsExecuted.length;
		sideEffectsExecuted = [];

		// Verify effects are queued
		let pending = engine.getPendingSideEffects("task-1");
		expect(pending.length).toBeGreaterThan(0);

		// Reject side effects
		engine.rejectSideEffects("task-1");

		// Verify effects were NOT executed again
		expect(sideEffectsExecuted).toHaveLength(0);

		// Verify queue is cleared
		pending = engine.getPendingSideEffects("task-1");
		expect(pending).toHaveLength(0);
	});

	test("rejectSideEffects handles missing task gracefully", async () => {
		// Should not throw
		engine.rejectSideEffects("unknown-task");

		// Should still have no executed effects
		expect(sideEffectsExecuted).toHaveLength(0);
	});

	test("multiple dispatches queue side effects independently per task", async () => {
		const task1 = makeTask("task-1");
		const task2 = makeTask("task-2");

		// Setup issuer to skip for both
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: true,
			message: null,
			reason: "Complete",
			raw: null,
		});

		await engine.dispatchAgent("scout", task1);
		await engine.dispatchAgent("scout", task2);

		// Verify effects are queued separately
		const pending1 = engine.getPendingSideEffects("task-1");
		const pending2 = engine.getPendingSideEffects("task-2");

		expect(pending1.length).toBeGreaterThan(0);
		expect(pending2.length).toBeGreaterThan(0);

		// Approve only task-1
		await engine.approveSideEffects("task-1");

		// task-1 should be cleared, task-2 should still be queued
		expect(engine.getPendingSideEffects("task-1")).toHaveLength(0);
		expect(engine.getPendingSideEffects("task-2").length).toBeGreaterThan(0);
	});

	test("approveSideEffects continues despite individual effect failures", async () => {
		const task = makeTask("task-1");
		// Setup issuer to defer (generates comment + status)
		(pipelineManager as any).runIssuerForTask = async () => ({
			start: false,
			skip: false,
			message: "Waiting",
			reason: "Dependencies",
			raw: null,
		});

		await engine.dispatchAgent("scout", task);
		// Make comment execution fail
		(tasksClient as any).comment = async () => {
			throw new Error("Comment service unavailable");
		};

		// Should not throw even though comment fails
		// (side effect errors are non-fatal in executeSideEffects)
		await engine.approveSideEffects("task-1");
		// Queue should be cleared after approval
		expect(engine.getPendingSideEffects("task-1")).toHaveLength(0);
	});
});
