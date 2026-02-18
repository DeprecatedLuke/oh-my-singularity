import { describe, expect, test } from "bun:test";

import { AgentRegistry } from "../agents/registry";
import { createEmptyAgentUsage } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { handleIpcMessage } from "./handlers";

function makeIssue(id: string, overrides: Partial<TaskIssue> = {}): TaskIssue {
	return {
		id,
		title: `Issue ${id}`,
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

function createRegistry(tasksClient: TaskStoreClient): AgentRegistry {
	const registry = new AgentRegistry({ tasksClient });
	registry.register({
		id: "system",
		role: "singularity",
		taskId: null,
		tasksAgentId: "system-agent",
		status: "running",
		usage: createEmptyAgentUsage(),
		events: [],
		spawnedAt: 1,
		lastActivity: 1,
	});
	return registry;
}

function createLoopStub(overrides: Record<string, unknown> = {}) {
	return {
		advanceIssuerLifecycle: (opts: unknown) => ({ ok: true, opts }),
		handleFinisherCloseTask: async (opts: unknown) => ({ ok: true, opts }),
		broadcastToWorkers: async (_message: string, _meta?: unknown) => {},
		interruptAgent: async (_taskId: string, _message: string) => true,
		steerAgent: async (_taskId: string, _message: string) => true,
		spawnAgentBySingularity: async (_opts: unknown) => {},
		stopAgentsForTask: async (_taskId: string, _opts?: unknown) => {},
		complain: async (_opts: unknown) => ({ ok: true }),
		revokeComplaint: async (_opts: unknown) => ({ ok: true }),
		isRunning: () => true,
		isPaused: () => false,
		resume: () => {},
		wake: () => {},
		...overrides,
	};
}

describe("handleIpcMessage", () => {
	test("tasks_request list delegates to tasks client with parsed args", async () => {
		const listCalls: Array<readonly string[] | undefined> = [];
		const tasksClient = {
			list: async (args?: readonly string[]) => {
				listCalls.push(args);
				return [makeIssue("task-1")];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "list",
				params: { includeClosed: true, status: "open", type: "task", limit: 5 },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect(Array.isArray(response.data)).toBe(true);
		expect(listCalls[0]).toEqual(["--all", "--status", "open", "--type", "task", "--limit", "5"]);
	});

	test("tasks_request returns validation errors for missing required params", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const showError = await handleIpcMessage({
			payload: { type: "tasks_request", action: "show", params: {} },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(showError).toEqual({ ok: false, error: "id is required for show" });

		const createError = await handleIpcMessage({
			payload: { type: "tasks_request", action: "create", params: {} },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(createError).toEqual({ ok: false, error: "title is required for create" });
	});

	test("tasks_request create forwards depends_on values", async () => {
		const createCalls: Array<{
			title: string;
			description?: string | null;
			priority?: number;
			options?: unknown;
		}> = [];
		const tasksClient = {
			create: async (title: string, description?: string | null, priority?: number, options?: unknown) => {
				createCalls.push({ title, description, priority, options });
				return makeIssue(`task-${createCalls.length}`, { title });
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const single = await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "create",
				params: { title: "Single dependency", depends_on: "task-100" },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(single).toEqual(
			expect.objectContaining({
				ok: true,
			}),
		);

		const multi = await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "create",
				params: {
					title: "Multiple dependencies",
					depends_on: ["task-100", "task-101"],
				},
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(multi).toEqual(
			expect.objectContaining({
				ok: true,
			}),
		);

		const firstOptions = createCalls[0]?.options as { depends_on?: string | string[] } | undefined;
		const secondOptions = createCalls[1]?.options as { depends_on?: string | string[] } | undefined;
		expect(firstOptions?.depends_on).toBe("task-100");
		expect(secondOptions?.depends_on).toEqual(["task-100", "task-101"]);
	});

	test("tasks_request supports defaultTaskId fallback", async () => {
		const commentCalls: Array<{ id: string; text: string }> = [];
		const tasksClient = {
			comment: async (id: string, text: string) => {
				commentCalls.push({ id, text });
				return { id, text };
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "comment_add",
				defaultTaskId: "task-55",
				params: { text: "note" },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown };

		expect(response.ok).toBe(true);
		expect(commentCalls).toEqual([{ id: "task-55", text: "note" }]);
	});

	test("issuer_advance_lifecycle returns unavailable when loop is missing", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = await handleIpcMessage({
			payload: { type: "issuer_advance_lifecycle", taskId: "task-1", action: "next" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(response).toEqual({ ok: false, summary: "Agent loop unavailable" });
	});

	test("issuer_advance_lifecycle and finisher_close_task delegate to loop", async () => {
		const calls: { issuer: unknown[]; finisher: unknown[] } = { issuer: [], finisher: [] };
		const loop = createLoopStub({
			advanceIssuerLifecycle: (opts: unknown) => {
				calls.issuer.push(opts);
				return { ok: true, kind: "issuer" };
			},
			handleFinisherCloseTask: async (opts: unknown) => {
				calls.finisher.push(opts);
				return { ok: true, kind: "finisher" };
			},
		});
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const issuer = await handleIpcMessage({
			payload: {
				type: "issuer_advance_lifecycle",
				taskId: "task-1",
				action: "promote",
				message: "go",
				reason: "ok",
				agentId: "agent-1",
			},
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const finisher = await handleIpcMessage({
			payload: { type: "finisher_close_task", taskId: "task-1", reason: "done", agentId: "fin-1" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(issuer).toEqual({ ok: true, kind: "issuer" });
		expect(finisher).toEqual({ ok: true, kind: "finisher" });
		expect(calls.issuer).toHaveLength(1);
		expect(calls.finisher).toHaveLength(1);
	});

	test("broadcast ignores empty message and delegates non-empty", async () => {
		const sent: string[] = [];
		const loop = createLoopStub({
			broadcastToWorkers: async (message: string) => {
				sent.push(message);
			},
		});
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		await handleIpcMessage({
			payload: { type: "broadcast", message: "   " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		await handleIpcMessage({
			payload: { type: "broadcast", message: "ship it" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(sent).toEqual(["ship it"]);
	});

	test("interrupt, steer, replace, stop, complain, revoke delegate correctly", async () => {
		const calls: {
			interrupt: unknown[];
			steer: unknown[];
			replace: unknown[];
			stop: unknown[];
			complain: unknown[];
			revoke: unknown[];
		} = { interrupt: [], steer: [], replace: [], stop: [], complain: [], revoke: [] };
		let stopAwaited = false;
		const loop = createLoopStub({
			interruptAgent: async (taskId: string, message: string) => {
				calls.interrupt.push({ taskId, message });
				return true;
			},
			steerAgent: async (taskId: string, message: string) => {
				calls.steer.push({ taskId, message });
				return true;
			},
			spawnAgentBySingularity: async (opts: unknown) => {
				calls.replace.push(opts);
			},
			stopAgentsForTask: async (taskId: string, opts: unknown) => {
				await Bun.sleep(5);
				stopAwaited = true;
				calls.stop.push({ taskId, opts });
			},
			complain: async (opts: unknown) => {
				calls.complain.push(opts);
				return { ok: true };
			},
			revokeComplaint: async (opts: unknown) => {
				calls.revoke.push(opts);
				return { ok: true };
			},
		});
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		await handleIpcMessage({
			payload: { type: "interrupt_agent", taskId: " task-1 ", message: " stop now " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		await handleIpcMessage({
			payload: { type: "steer_agent", taskId: " task-1 ", message: " keep going " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: " task-1 ", context: " context " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		await handleIpcMessage({
			payload: { type: "stop_agents_for_task", taskId: " task-1 ", includeFinisher: true, waitForCompletion: true },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		await handleIpcMessage({
			payload: {
				type: "complain",
				files: [" a.ts ", "", 7],
				reason: "blocked",
				complainantAgentId: "agent-1",
			},
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		await handleIpcMessage({
			payload: {
				type: "revoke_complaint",
				files: [" a.ts ", "", 7],
				complainantAgentId: "agent-1",
			},
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(calls.interrupt).toEqual([{ taskId: "task-1", message: "stop now" }]);
		expect(calls.steer).toEqual([{ taskId: "task-1", message: "keep going" }]);
		expect(calls.replace[0]).toEqual({ role: "worker", taskId: "task-1", context: "context" });
		expect(calls.stop[0]).toEqual({ taskId: "task-1", opts: { includeFinisher: true } });
		expect(stopAwaited).toBe(true);
		expect(calls.complain[0]).toEqual({
			complainantAgentId: "agent-1",
			complainantTaskId: undefined,
			files: ["a.ts"],
			reason: "blocked",
		});
		expect(calls.revoke[0]).toEqual({
			complainantAgentId: "agent-1",
			complainantTaskId: undefined,
			files: ["a.ts"],
		});
	});

	test("complain/revoke return unavailable when loop is null", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const complain = await handleIpcMessage({
			payload: { type: "complain", files: [], reason: "x" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const revoke = await handleIpcMessage({
			payload: { type: "revoke_complaint" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(complain).toEqual({ ok: false, summary: "Agent loop unavailable" });
		expect(revoke).toEqual({ ok: false, summary: "Agent loop unavailable" });
	});

	test("wait_for_agent validates agentId and resolves terminal/not_found statuses", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "agent-done",
			role: "worker",
			taskId: "task-1",
			tasksAgentId: "agent-done",
			status: "done",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});

		const missing = await handleIpcMessage({
			payload: { type: "wait_for_agent", agentId: "  " },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(missing).toEqual({ ok: false, error: "wait_for_agent: agentId is required" });

		const notFound = (await handleIpcMessage({
			payload: { type: "wait_for_agent", agentId: "missing", timeoutMs: 1_000 },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; status?: string };
		expect(notFound.ok).toBe(true);
		expect(notFound.status).toBe("not_found");

		const done = (await handleIpcMessage({
			payload: { type: "wait_for_agent", agentId: "agent-done", timeoutMs: 1_000 },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; status?: string };
		expect(done.ok).toBe(true);
		expect(done.status).toBe("done");
	});

	test("list_active_agents returns active summaries", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker-active",
			role: "worker",
			taskId: "task-1",
			tasksAgentId: "agent-active",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 10,
		});
		registry.register({
			id: "worker-done",
			role: "worker",
			taskId: "task-1",
			tasksAgentId: "agent-done-2",
			status: "done",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 9,
		});

		const result = (await handleIpcMessage({
			payload: { type: "list_active_agents" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; activeAgents: Array<{ id: string }> };

		expect(result.ok).toBe(true);
		expect(result.activeAgents.map(agent => agent.id)).toContain("worker-active");
		expect(result.activeAgents.map(agent => agent.id)).not.toContain("worker-done");
	});

	test("list_task_agents merges live and persisted without duplicates", async () => {
		const tasksClient = {
			list: async () => [
				makeIssue("agent-live", {
					issue_type: "agent",
					title: "worker-task-1",
					status: "done",
					hook_task: "task-1",
					updated_at: "2026-01-01T00:00:02.000Z",
				}),
				makeIssue("agent-persisted", {
					issue_type: "agent",
					title: "finisher-task-1",
					status: "done",
					hook_task: "task-1",
					updated_at: "2026-01-01T00:00:03.000Z",
				}),
			],
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker:task-1:live",
			role: "worker",
			taskId: "task-1",
			tasksAgentId: "agent-live",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 100,
		});

		const result = (await handleIpcMessage({
			payload: { type: "list_task_agents", taskId: "task-1" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; agents: Array<{ id: string; tasksAgentId: string }> };

		expect(result.ok).toBe(true);
		expect(result.agents.map(agent => agent.id)).toContain("worker:task-1:live");
		expect(result.agents.map(agent => agent.id)).toContain("agent-persisted");
		expect(result.agents.filter(agent => agent.tasksAgentId === "agent-live")).toHaveLength(1);
	});

	test("read_message_history enforces task boundary for live and persisted agents", async () => {
		const tasksClient = {
			show: async () =>
				makeIssue("agent-42", {
					issue_type: "agent",
					hook_task: "task-other",
				}),
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker:task-2:1",
			role: "worker",
			taskId: "task-2",
			tasksAgentId: "agent-live",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});

		const liveMismatch = (await handleIpcMessage({
			payload: { type: "read_message_history", agentId: "agent-live", taskId: "task-1", limit: 10 },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; summary: string };
		expect(liveMismatch.ok).toBe(false);
		expect(liveMismatch.summary).toContain("outside task task-1");

		const persistedMismatch = (await handleIpcMessage({
			payload: { type: "read_message_history", agentId: "agent-42", taskId: "task-1", limit: 10 },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; summary: string };
		expect(persistedMismatch.ok).toBe(false);
		expect(persistedMismatch.summary).toContain("outside task task-1");
	});

	test("read_message_history returns registry history when in scope", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.readMessageHistory = async () => ({
			agent: null,
			messages: [{ role: "assistant", content: "hello" }],
			toolCalls: [],
		});

		const result = (await handleIpcMessage({
			payload: { type: "read_message_history", agentId: "agent-1", taskId: "", limit: 5 },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; history: { messages: unknown[] } };

		expect(result.ok).toBe(true);
		expect(result.history.messages).toHaveLength(1);
	});

	test("wake branch resumes paused loop or triggers early wake", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		let resumed = 0;
		let woke = 0;
		let early = 0;
		const runningLoop = createLoopStub({
			isRunning: () => true,
			isPaused: () => true,
			resume: () => {
				resumed += 1;
			},
			wake: () => {
				woke += 1;
			},
		});

		await handleIpcMessage({
			payload: { foo: "bar" },
			loop: runningLoop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
			onEarlyWake: () => {
				early += 1;
			},
		});
		expect(resumed).toBe(1);
		expect(woke).toBe(1);
		expect(early).toBe(0);

		const stoppedLoop = createLoopStub({ isRunning: () => false });
		await handleIpcMessage({
			payload: { type: "wake" },
			loop: stoppedLoop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
			onEarlyWake: () => {
				early += 1;
			},
		});
		expect(early).toBe(1);
	});
	test("start_tasks delegates to loop.startTasks with normalized count and returns result", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		let receivedCount: number | undefined;
		const runningLoop = createLoopStub({
			isRunning: () => true,
			startTasks: async (count?: number) => {
				receivedCount = count;
				return { ok: true, spawned: 1, taskIds: ["task-7"] };
			},
		});
		let result = (await handleIpcMessage({
			payload: { type: "start_tasks", count: 2.5 },
			loop: runningLoop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; spawned: number; taskIds: string[] };
		expect(result).toEqual({ ok: true, spawned: 1, taskIds: ["task-7"] });
		expect(receivedCount).toBe(2);

		result = (await handleIpcMessage({
			payload: { type: "start_tasks" },
			loop: runningLoop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; spawned: number; taskIds: string[] };
		expect(result).toEqual({ ok: true, spawned: 1, taskIds: ["task-7"] });
		expect(receivedCount).toBeUndefined();

		const stoppedLoop = createLoopStub({ isRunning: () => false });
		const unavailable = (await handleIpcMessage({
			payload: { type: "start_tasks" },
			loop: stoppedLoop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; summary: string };
		expect(unavailable).toEqual({ ok: false, summary: "Agent loop not running" });
	});
});
