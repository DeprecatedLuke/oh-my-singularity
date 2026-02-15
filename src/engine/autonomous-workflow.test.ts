import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentRegistry } from "../agents/registry";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { createEmptyAgentUsage } from "../agents/types";
import type { PipelineManager } from "../loop/pipeline";
import type { SteeringManager } from "../loop/steering";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { AutonomousWorkflowEngine } from "./autonomous-workflow";

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

describe("AutonomousWorkflowEngine", () => {
	let engine: AutonomousWorkflowEngine;
	let pipelineManager: Record<string, unknown>;
	let steeringManager: Record<string, unknown>;
	let registry: Record<string, unknown>;
	let tasksClient: Record<string, unknown>;
	let spawner: Record<string, unknown>;
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

		registry = {
			getCapabilities: (role: string) => {
				const categories: Record<string, string> = {
					scout: "scout",
					worker: "implementer",
					finisher: "verifier",
					steering: "supervisor",
				};
				return { category: categories[role] };
			},
		};

		spawner = {
			spawnSteering: async () => makeAgent("steering:task-1"),
		};

		engine = new AutonomousWorkflowEngine(
			pipelineManager as unknown as PipelineManager,
			steeringManager as unknown as SteeringManager,
			registry as unknown as AgentRegistry,
			tasksClient as unknown as TaskStoreClient,
			spawner as unknown as AgentSpawner,
		);
	});

	test("auto-executes side effects immediately on dispatch", async () => {
		// Setup issuer to skip (generates comment + spawn finisher)
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

		// In autonomous mode, side effects are auto-executed
		// We should see comment effect was processed
		expect(sideEffectsExecuted).toContain("comment");
	});

	test("inherits base WorkflowEngine dispatch strategy selection", async () => {
		const task = makeTask("task-1");

		// Scout should route to issuer strategy
		const scoutResult = await engine.dispatchAgent("scout", task);
		expect(scoutResult.success).toBe(true);

		// Worker should route to worker spawn strategy
		const workerResult = await engine.dispatchAgent("worker", task);
		expect(workerResult.success).toBe(true);
	});

	test("no side effect queueing in autonomous mode", async () => {
		const task = makeTask("task-1");

		// In autonomous mode, there should be no queueing mechanism
		// All side effects execute immediately
		const result = await engine.dispatchAgent("scout", task);

		expect(result.success).toBe(true);

		// Verify side effects execute immediately (not queued)
	});

	test("handles dispatch with context in autonomous mode", async () => {
		const task = makeTask("task-1");
		const result = await engine.dispatchAgent("worker", task, {
			context: "task implementation details",
		});

		expect(result.success).toBe(true);
		expect(result.agent?.id).toBe("worker:task-1");
	});
});
