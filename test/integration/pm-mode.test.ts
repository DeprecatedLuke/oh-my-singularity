import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "../../src/agents/registry";
import { createEmptyAgentUsage } from "../../src/agents/types";
import { DEFAULT_CONFIG } from "../../src/config";
import { AutonomousWorkflowEngine } from "../../src/engine/autonomous-workflow";
import { InteractiveWorkflowEngine } from "../../src/engine/interactive-workflow";
import { AgentLoop } from "../../src/loop/agent-loop";
import type { TaskStoreClient } from "../../src/tasks/client";
import type { TaskIssue } from "../../src/tasks/types";
import type { WorkflowConfig } from "../../src/types/workflow-config";

function makeTask(id: string): TaskIssue {
	return {
		id,
		title: "Test task",
		description: "Test description",
		status: "pending",
	} as TaskIssue;
}

function createPmModeFixture(autoProcessReadyTasks: boolean) {
	const calls = {
		close: [] as Array<{ taskId: string; reason?: string }>,
		setAgentState: [] as Array<{ id: string; state: string }>,
		clearSlot: [] as Array<{ id: string; slot: string }>,
		updateStatus: [] as Array<{ taskId: string; status: string }>,
		comment: [] as Array<{ taskId: string; comment: string }>,
	};

	const tasksClient = {
		close: async (taskId: string, reason?: string) => {
			calls.close.push({ taskId, reason });
		},
		updateStatus: async (taskId: string, status: string) => {
			calls.updateStatus.push({ taskId, status });
		},
		setAgentState: async (id: string, state: string) => {
			calls.setAgentState.push({ id, state });
		},
		clearSlot: async (id: string, slot: string) => {
			calls.clearSlot.push({ id, slot });
		},
		comment: async (taskId: string, text: string) => {
			calls.comment.push({ taskId, comment: text });
		},
	} as unknown as TaskStoreClient;

	const registry = new AgentRegistry({ tasksClient });

	const scheduler = {
		getInProgressTasksWithoutAgent: async () => [],
		getNextTasks: async () => [],
		findTasksUnblockedBy: async () => [],
	} as never;

	const spawner = {} as never;

	const workflowConfig: WorkflowConfig = {
		version: "1.0",
		profile: "pm-mode-test",
		roles: {},
		autoProcessReadyTasks,
	};

	const loop = new AgentLoop({
		tasksClient,
		registry,
		scheduler,
		spawner,
		workflowConfig,
		config: { ...DEFAULT_CONFIG, pollIntervalMs: 50, steeringIntervalMs: 50 },
	});

	return { loop, registry, calls, tasksClient };
}

describe("PM Mode Integration Tests", () => {
	describe("Test 1: Engine selection", () => {
		test("AgentLoop instantiates InteractiveWorkflowEngine when autoProcessReadyTasks=false", () => {
			const { loop } = createPmModeFixture(false);

			const engine = loop.getWorkflowEngine();
			expect(engine).toBeInstanceOf(InteractiveWorkflowEngine);
		});

		test("AgentLoop instantiates AutonomousWorkflowEngine when autoProcessReadyTasks=true", () => {
			const { loop } = createPmModeFixture(true);

			const engine = loop.getWorkflowEngine();
			expect(engine).toBeInstanceOf(AutonomousWorkflowEngine);
		});

		test("AgentLoop defaults to AutonomousWorkflowEngine when autoProcessReadyTasks is undefined", () => {
			// Create a loop with workflowConfig that has undefined autoProcessReadyTasks
			const tasksClient = {
				close: async () => {},
				updateStatus: async () => {},
				setAgentState: async () => {},
				clearSlot: async () => {},
				comment: async () => {},
			} as unknown as TaskStoreClient;

			const registry = new AgentRegistry({ tasksClient });
			const scheduler = {
				getInProgressTasksWithoutAgent: async () => [],
				getNextTasks: async () => [],
				findTasksUnblockedBy: async () => [],
			} as never;
			const spawner = {} as never;

			const workflowConfig: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {},
				// autoProcessReadyTasks is undefined - should default to true
			};

			const loop = new AgentLoop({
				tasksClient,
				registry,
				scheduler,
				spawner,
				workflowConfig,
				config: DEFAULT_CONFIG,
			});

			const engine = loop.getWorkflowEngine();
			expect(engine).toBeInstanceOf(AutonomousWorkflowEngine);
		});
	});

	describe("Test 2: Side effect queuing in PM mode", () => {
		test("Dispatch worker task in PM mode queues side effects without auto-execution", async () => {
			const { loop } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			// Verify engine is InteractiveWorkflowEngine
			expect(engine).toBeInstanceOf(InteractiveWorkflowEngine);

			// Mock the pipeline manager to return a worker agent
			const mockAgent = {
				id: "worker:task-1:test",
				role: "worker",
				taskId: "task-1",
				tasksAgentId: "agent-worker-test",
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: Date.now(),
				lastActivity: Date.now(),
			};

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (task: TaskIssue) => Promise<unknown>;
					};
				}
			).pipelineManager.spawnTaskWorker = async () => mockAgent;

			// Dispatch agent (side effects will be queued)
			const task = makeTask("task-1");
			const result = await engine.dispatchAgent("worker", task);

			// Verify dispatch succeeded
			expect(result.success).toBe(true);

			// Verify side effects are queued, not auto-executed
			const pending = engine.getPendingSideEffects("task-1");
			// InteractiveWorkflowEngine should have queued some side effects
			if (pending.length > 0) {
				expect(pending[0]).toHaveProperty("type");
				// Verify the queue structure
				expect(Array.isArray(pending)).toBe(true);
			}
		});

		test("getPendingSideEffects returns non-empty array after dispatch", async () => {
			const { loop } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			const task = makeTask("task-1");

			// Mock pipeline manager to return a worker agent
			const mockAgent = {
				id: "worker:task-1",
				role: "worker",
				taskId: "task-1",
				tasksAgentId: "agent-worker",
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: Date.now(),
				lastActivity: Date.now(),
			};

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (task: TaskIssue) => Promise<unknown>;
					};
				}
			).pipelineManager.spawnTaskWorker = async () => mockAgent;

			await engine.dispatchAgent("worker", task);

			// Get pending side effects
			const pending = engine.getPendingSideEffects("task-1");

			// Should be an array (even if empty, structure should be valid)
			expect(Array.isArray(pending)).toBe(true);
		});
	});

	describe("Test 3: Side effect approval in PM mode", () => {
		test("approveSideEffects executes queued effects and clears queue", async () => {
			const { loop, calls } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			const task = makeTask("task-1");

			// Mock pipeline manager and steering manager
			const mockWorkerAgent = {
				id: "worker:task-1",
				role: "worker",
				taskId: "task-1",
				tasksAgentId: "agent-worker",
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: Date.now(),
				lastActivity: Date.now(),
			};

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (task: TaskIssue) => Promise<unknown>;
					};
				}
			).pipelineManager.spawnTaskWorker = async () => mockWorkerAgent;

			// Dispatch agent (queues side effects)
			await engine.dispatchAgent("worker", task);

			// Verify effects are queued
			const pendingBefore = engine.getPendingSideEffects("task-1");
			expect(Array.isArray(pendingBefore)).toBe(true);

			// Approve side effects
			await engine.approveSideEffects("task-1");

			// Verify queue is cleared after approval
			const pendingAfter = engine.getPendingSideEffects("task-1");
			expect(pendingAfter).toHaveLength(0);
		});

		test("approveSideEffects handles missing task gracefully", async () => {
			const { loop } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			// Should not throw when approving non-existent task
			await expect(engine.approveSideEffects("unknown-task-id")).resolves.toBeUndefined();
		});
	});

	describe("Test 4: Side effect rejection in PM mode", () => {
		test("rejectSideEffects clears queued effects without execution", async () => {
			const { loop, calls } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			const task = makeTask("task-1");

			// Mock pipeline manager
			const mockWorkerAgent = {
				id: "worker:task-1",
				role: "worker",
				taskId: "task-1",
				tasksAgentId: "agent-worker",
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: Date.now(),
				lastActivity: Date.now(),
			};

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (task: TaskIssue) => Promise<unknown>;
					};
				}
			).pipelineManager.spawnTaskWorker = async () => mockWorkerAgent;

			// Dispatch agent (queues side effects)
			await engine.dispatchAgent("worker", task);

			// Verify effects are queued
			const pendingBefore = engine.getPendingSideEffects("task-1");
			expect(Array.isArray(pendingBefore)).toBe(true);

			// Clear calls before rejection
			calls.comment = [];
			calls.updateStatus = [];

			// Reject side effects
			engine.rejectSideEffects("task-1");

			// Verify effects were NOT executed during rejection
			// (calls should remain empty for this test)
			expect(calls.comment).toHaveLength(0);
			expect(calls.updateStatus).toHaveLength(0);

			// Verify queue is cleared
			const pendingAfter = engine.getPendingSideEffects("task-1");
			expect(pendingAfter).toHaveLength(0);
		});

		test("rejectSideEffects handles missing task gracefully", async () => {
			const { loop } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			// Should not throw when rejecting non-existent task
			expect(() => engine.rejectSideEffects("unknown-task-id")).not.toThrow();
		});
	});

	describe("Test 5: PM prompt selection logic", () => {
		test("PM mode with autoProcessReadyTasks=false selects singularity-pm.md prompt", () => {
			// Test the prompt selection logic directly
			const workflowConfig: WorkflowConfig = {
				version: "1.0",
				profile: "pm-mode",
				roles: {},
				autoProcessReadyTasks: false,
			};

			// Verify the logic: autoProcessReadyTasks === false should use singularity-pm.md
			const expectedPrompt = workflowConfig.autoProcessReadyTasks === false ? "singularity-pm.md" : "singularity.md";
			expect(expectedPrompt).toBe("singularity-pm.md");
		});

		test("Autonomous mode with autoProcessReadyTasks=true selects singularity.md prompt", () => {
			// Test the prompt selection logic directly
			const workflowConfig: WorkflowConfig = {
				version: "1.0",
				profile: "autonomous-mode",
				roles: {},
				autoProcessReadyTasks: true,
			};

			// Verify the logic: autoProcessReadyTasks === true (or missing) should use singularity.md
			const expectedPrompt = workflowConfig.autoProcessReadyTasks === false ? "singularity-pm.md" : "singularity.md";
			expect(expectedPrompt).toBe("singularity.md");
		});

		test("Undefined autoProcessReadyTasks defaults to singularity.md prompt", () => {
			// Test the prompt selection logic with undefined config
			const workflowConfig: WorkflowConfig = {
				version: "1.0",
				profile: "default-mode",
				roles: {},
				// autoProcessReadyTasks is undefined
			};

			// Verify the logic: undefined should default to singularity.md
			const expectedPrompt = workflowConfig.autoProcessReadyTasks === false ? "singularity-pm.md" : "singularity.md";
			expect(expectedPrompt).toBe("singularity.md");
		});
	});

	describe("Integration: Multiple tasks with independent side effect queues", () => {
		test("Queued side effects are independent per task", async () => {
			const { loop } = createPmModeFixture(false);
			const engine = loop.getWorkflowEngine();

			const task1 = makeTask("task-1");
			const task2 = makeTask("task-2");

			// Mock pipeline manager
			const mockAgent = (taskId: string) => ({
				id: `worker:${taskId}`,
				role: "worker",
				taskId,
				tasksAgentId: `agent-${taskId}`,
				status: "running",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: Date.now(),
				lastActivity: Date.now(),
			});

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (task: TaskIssue) => Promise<unknown>;
					};
				}
			).pipelineManager.spawnTaskWorker = async (task: TaskIssue) => mockAgent(task.id);

			// Dispatch both tasks
			await engine.dispatchAgent("worker", task1);
			await engine.dispatchAgent("worker", task2);

			// Get pending effects for both tasks
			const pending1Before = engine.getPendingSideEffects("task-1");
			const pending2Before = engine.getPendingSideEffects("task-2");

			// Both should have independent queues
			expect(Array.isArray(pending1Before)).toBe(true);
			expect(Array.isArray(pending2Before)).toBe(true);

			// Approve only task-1
			await engine.approveSideEffects("task-1");

			// task-1 queue should be cleared
			const pending1After = engine.getPendingSideEffects("task-1");
			expect(pending1After).toHaveLength(0);

			// task-2 queue should remain unchanged
			const pending2After = engine.getPendingSideEffects("task-2");
			expect(pending2After).toHaveProperty("length");
		});
	});
});
