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
	test("tasks_request list delegates to tasks client with parsed args and returns compact objects", async () => {
		const listCalls: Array<readonly string[] | undefined> = [];
		const tasksClient = {
			list: async (args?: readonly string[]) => {
				listCalls.push(args);
				return [
					makeIssue("task-1", {
						assignee: "alice",
						priority: 1,
						depends_on_ids: ["task-2"],
					}),
					makeIssue("task-2", {
						status: "closed",
						priority: 4,
						issue_type: "bug",
						depends_on_ids: ["task-1", "task-3"],
					}),
					makeIssue("task-3", {
						status: "done",
						priority: 0,
						issue_type: "agent",
					}),
				];
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
		expect(response.data).toEqual([
			{
				id: "task-1",
				title: "Issue task-1",
				status: "open",
				priority: 1,
				assignee: "alice",
				dependency_count: 1,
				issue_type: "task",
			},
			{
				id: "task-2",
				title: "Issue task-2",
				status: "closed",
				priority: 4,
				assignee: null,
				dependency_count: 2,
				issue_type: "bug",
			},
			{
				id: "task-3",
				title: "Issue task-3",
				status: "done",
				priority: 0,
				assignee: null,
				dependency_count: 0,
				issue_type: "agent",
			},
		]);
		expect(listCalls[0]).toEqual(["--all", "--status", "open", "--type", "task", "--limit", "5"]);
	});

	test("tasks_request list excludes closed and terminal statuses, keeps blocked, and defaults dependency_count to zero", async () => {
		const listCalls: Array<readonly string[] | undefined> = [];
		const tasksClient = {
			list: async (args?: readonly string[]) => {
				listCalls.push(args);
				return [
					makeIssue("task-1", {
						status: "open",
						priority: 2,
						depends_on_ids: ["task-2", "task-3"],
					}),
					makeIssue("task-2", {
						status: "closed",
						priority: 3,
						assignee: "bob",
						depends_on_ids: ["task-9"],
					}),
					makeIssue("task-3", {
						status: "blocked",
						priority: 0,
						issue_type: "feature",
					}),
					makeIssue("task-4", {
						status: "done",
					}),
					makeIssue("task-5", {
						status: "dead",
					}),
				];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "list", params: {} },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect(response.data).toEqual([
			{
				id: "task-1",
				title: "Issue task-1",
				status: "open",
				priority: 2,
				assignee: null,
				dependency_count: 2,
				issue_type: "task",
			},
			{
				id: "task-3",
				title: "Issue task-3",
				status: "blocked",
				priority: 0,
				assignee: null,
				dependency_count: 0,
				issue_type: "feature",
			},
		]);
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 7)).toBe(true);
		expect(listCalls[0]).toEqual(["--status", "open", "--limit", "50"]);
	});

	test("tasks_request list respects explicit status without includeClosed", async () => {
		const listCalls: Array<readonly string[] | undefined> = [];
		const tasksClient = {
			list: async (args?: readonly string[]) => {
				listCalls.push(args);
				return [
					makeIssue("task-done", {
						status: "done",
					}),
				];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "list", params: { status: "done" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { status: string }).status)).toEqual(["done"]);
		expect(listCalls[0]).toEqual(["--status", "done", "--limit", "50"]);
	});

	test("tasks_request list sorts by updated_at descending and treats invalid timestamps as oldest", async () => {
		const tasksClient = {
			list: async () => [
				makeIssue("task-old", {
					updated_at: "2026-01-01T00:00:01.000Z",
				}),
				makeIssue("task-invalid", {
					updated_at: "not-a-date",
				}),
				makeIssue("task-new", {
					updated_at: "2026-01-01T00:00:03.000Z",
				}),
				makeIssue("task-mid", {
					updated_at: "2026-01-01T00:00:02.000Z",
				}),
			],
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "list", params: {} },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual([
			"task-new",
			"task-mid",
			"task-old",
			"task-invalid",
		]);
	});

	test("tasks_request search sorts by updated_at descending and treats invalid timestamps as oldest", async () => {
		const tasksClient = {
			search: async () => [
				makeIssue("task-old", {
					updated_at: "2026-01-01T00:00:01.000Z",
				}),
				makeIssue("task-invalid", {
					status: "blocked",
					updated_at: "not-a-date",
				}),
				makeIssue("task-new", {
					updated_at: "2026-01-01T00:00:03.000Z",
				}),
				makeIssue("task-mid", {
					updated_at: "2026-01-01T00:00:02.000Z",
				}),
			],
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "search", params: { query: "alpha" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual([
			"task-new",
			"task-mid",
			"task-old",
			"task-invalid",
		]);
	});

	test("tasks_request search defaults limit to 50 and forwards includeComments/status", async () => {
		const searchCalls: Array<{ query: string; options: unknown }> = [];
		const tasksClient = {
			search: async (query: string, options?: unknown) => {
				searchCalls.push({ query, options });
				return [];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "search",
				params: { query: "alpha", includeComments: true, status: "blocked" },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(response).toEqual({ ok: true, data: [] });
		expect(searchCalls).toEqual([
			{
				query: "alpha",
				options: {
					includeComments: true,
					status: "blocked",
					limit: 50,
				},
			},
		]);
	});

	test("tasks_request search defaults status to open when status is omitted", async () => {
		const searchCalls: Array<{ query: string; options: unknown }> = [];
		const tasksClient = {
			search: async (query: string, options?: unknown) => {
				searchCalls.push({ query, options });
				return [];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = await handleIpcMessage({
			payload: { type: "tasks_request", action: "search", params: { query: "alpha" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(response).toEqual({ ok: true, data: [] });
		expect(searchCalls).toEqual([
			{
				query: "alpha",
				options: {
					includeComments: false,
					status: "open",
					limit: 50,
				},
			},
		]);
	});

	test("tasks_request search excludes closed and terminal statuses by default", async () => {
		const tasksClient = {
			search: async () => [
				makeIssue("task-open", {
					status: "open",
					updated_at: "2026-01-01T00:00:08.000Z",
				}),
				makeIssue("task-blocked", {
					status: "blocked",
					updated_at: "2026-01-01T00:00:07.000Z",
				}),
				makeIssue("task-closed", {
					status: "closed",
					updated_at: "2026-01-01T00:00:06.000Z",
				}),
				makeIssue("task-done", {
					status: "done",
					updated_at: "2026-01-01T00:00:05.000Z",
				}),
				makeIssue("task-failed", {
					status: "failed",
					updated_at: "2026-01-01T00:00:04.000Z",
				}),
				makeIssue("task-dead", {
					status: "dead",
					updated_at: "2026-01-01T00:00:03.000Z",
				}),
			],
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "search", params: { query: "alpha" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual(["task-open", "task-blocked"]);
	});

	test("tasks_request search includeClosed=true bypasses closed/terminal filtering", async () => {
		const tasksClient = {
			search: async () => [
				makeIssue("task-open", {
					status: "open",
					updated_at: "2026-01-01T00:00:08.000Z",
				}),
				makeIssue("task-blocked", {
					status: "blocked",
					updated_at: "2026-01-01T00:00:07.000Z",
				}),
				makeIssue("task-closed", {
					status: "closed",
					updated_at: "2026-01-01T00:00:06.000Z",
				}),
				makeIssue("task-done", {
					status: "done",
					updated_at: "2026-01-01T00:00:05.000Z",
				}),
				makeIssue("task-failed", {
					status: "failed",
					updated_at: "2026-01-01T00:00:04.000Z",
				}),
				makeIssue("task-dead", {
					status: "dead",
					updated_at: "2026-01-01T00:00:03.000Z",
				}),
			],
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "search",
				params: { query: "alpha", includeClosed: true },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual([
			"task-open",
			"task-blocked",
			"task-closed",
			"task-done",
			"task-failed",
			"task-dead",
		]);
	});

	test("tasks_request search respects explicit status without includeClosed", async () => {
		const searchCalls: Array<{ query: string; options: unknown }> = [];
		const tasksClient = {
			search: async (query: string, options?: unknown) => {
				searchCalls.push({ query, options });
				return [
					makeIssue("task-done", {
						status: "done",
					}),
				];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "search", params: { query: "alpha", status: "done" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual(["task-done"]);
		expect(searchCalls).toEqual([
			{
				query: "alpha",
				options: {
					includeComments: false,
					status: "done",
					limit: 50,
				},
			},
		]);
	});

	test("tasks_request ready returns compact 7-field objects", async () => {
		const tasksClient = {
			ready: async () => [
				makeIssue("task-ready-1", {
					priority: 1,
					assignee: "alice",
					depends_on_ids: ["task-x", "task-y"],
					description: "Long text",
					acceptance_criteria: "Accept",
					comments: [
						{
							id: 1,
							issue_id: "task-ready-1",
							author: "alice",
							text: "ready comment",
							created_at: "2026-01-01T00:00:00.000Z",
						},
					],
					close_reason: "done",
					usage_totals: { input: 10, output: 4 },
					metadata: { large: "payload" },
				}),
				makeIssue("task-ready-2", {
					status: "blocked",
					priority: 3,
					assignee: null,
					issue_type: "bug",
					description: "Other long text",
					acceptance_criteria: "Ship",
					comments: [
						{
							id: 2,
							issue_id: "task-ready-2",
							author: "system",
							text: "ready note",
							created_at: "2026-01-01T00:00:00.000Z",
						},
					],
					depends_on_ids: [],
					close_reason: "blocked",
					usage_totals: { input: 20, output: 8 },
					metadata: { large: "blob" },
				}),
			],
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "ready", params: {} },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect(response.data).toEqual([
			{
				id: "task-ready-1",
				title: "Issue task-ready-1",
				status: "open",
				priority: 1,
				assignee: "alice",
				dependency_count: 2,
				issue_type: "task",
			},
			{
				id: "task-ready-2",
				title: "Issue task-ready-2",
				status: "blocked",
				priority: 3,
				assignee: null,
				dependency_count: 0,
				issue_type: "bug",
			},
		]);
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 7)).toBe(true);
		for (const item of response.data ?? []) {
			expect(item).not.toHaveProperty("description");
			expect(item).not.toHaveProperty("acceptance_criteria");
			expect(item).not.toHaveProperty("created_at");
			expect(item).not.toHaveProperty("updated_at");
			expect(item).not.toHaveProperty("comments");
			expect(item).not.toHaveProperty("labels");
			expect(item).not.toHaveProperty("depends_on_ids");
			expect(item).not.toHaveProperty("close_reason");
			expect(item).not.toHaveProperty("usage_totals");
			expect(item).not.toHaveProperty("metadata");
		}
	});

	test("tasks_request search returns compact 7-field objects without verbose fields", async () => {
		const searchCalls: Array<{ query: string; options: unknown }> = [];
		const tasksClient = {
			search: async (query: string, options?: unknown) => {
				searchCalls.push({ query, options });
				return [
					makeIssue("task-search-open", {
						status: "open",
						priority: 2,
						assignee: null,
						updated_at: "2026-01-01T00:00:01.000Z",
						depends_on_ids: ["task-a", "task-b"],
						description: "Long text",
						acceptance_criteria: "Accept",
						comments: [
							{
								id: 3,
								issue_id: "task-search-open",
								author: "alice",
								text: "search open",
								created_at: "2026-01-01T00:00:00.000Z",
							},
						],
						close_reason: "none",
						usage_totals: { input: 3, output: 1 },
						metadata: { payload: "open" },
					}),
					makeIssue("task-search-closed", {
						status: "closed",
						priority: 4,
						updated_at: "2026-01-01T00:00:04.000Z",
						description: "Closed text",
						acceptance_criteria: "Close",
						comments: [],
						close_reason: "done",
						usage_totals: { input: 5, output: 2 },
						metadata: { payload: "closed" },
					}),
					makeIssue("task-search-blocked", {
						status: "blocked",
						priority: 1,
						assignee: "nina",
						updated_at: "2026-01-01T00:00:03.000Z",
						description: "Blocked text",
						acceptance_criteria: "Block",
						comments: [
							{
								id: 4,
								issue_id: "task-search-blocked",
								author: "nina",
								text: "search blocked",
								created_at: "2026-01-01T00:00:00.000Z",
							},
						],
						depends_on_ids: ["task-c"],
						close_reason: "waiting",
						usage_totals: { input: 7, output: 3 },
						metadata: { payload: "blocked" },
					}),
					makeIssue("task-search-done", {
						status: "done",
						updated_at: "2026-01-01T00:00:05.000Z",
						description: "Done text",
						acceptance_criteria: "Done",
						comments: [],
						close_reason: "done",
						usage_totals: { input: 9, output: 4 },
						metadata: { payload: "done" },
					}),
				];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "search", params: { query: "test" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect(response.data).toEqual([
			{
				id: "task-search-blocked",
				title: "Issue task-search-blocked",
				status: "blocked",
				priority: 1,
				assignee: "nina",
				dependency_count: 1,
				issue_type: "task",
			},
			{
				id: "task-search-open",
				title: "Issue task-search-open",
				status: "open",
				priority: 2,
				assignee: null,
				dependency_count: 2,
				issue_type: "task",
			},
		]);
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 7)).toBe(true);
		for (const item of response.data ?? []) {
			expect(item).not.toHaveProperty("description");
			expect(item).not.toHaveProperty("acceptance_criteria");
			expect(item).not.toHaveProperty("created_at");
			expect(item).not.toHaveProperty("updated_at");
			expect(item).not.toHaveProperty("comments");
			expect(item).not.toHaveProperty("labels");
			expect(item).not.toHaveProperty("depends_on_ids");
			expect(item).not.toHaveProperty("close_reason");
			expect(item).not.toHaveProperty("usage_totals");
			expect(item).not.toHaveProperty("metadata");
		}
		expect(searchCalls).toEqual([
			{
				query: "test",
				options: {
					includeComments: false,
					status: "open",
					limit: 50,
				},
			},
		]);
	});

	test("tasks_request query returns compact 7-field objects without verbose fields", async () => {
		const queryCalls: Array<{ query: string; args: readonly string[] | undefined }> = [];
		const tasksClient = {
			query: async (query: string, args?: readonly string[]) => {
				queryCalls.push({ query, args });
				return [
					makeIssue("task-query-1", {
						priority: 4,
						assignee: null,
						depends_on_ids: ["task-k", "task-l"],
						description: "Query text",
						acceptance_criteria: "Query accept",
						comments: [
							{
								id: 5,
								issue_id: "task-query-1",
								author: "sam",
								text: "query one",
								created_at: "2026-01-01T00:00:00.000Z",
							},
						],
						close_reason: "n/a",
						usage_totals: { input: 12, output: 5 },
						metadata: { payload: "query-1" },
					}),
					makeIssue("task-query-2", {
						status: "closed",
						priority: 0,
						assignee: "sam",
						description: "Query closed",
						acceptance_criteria: "Query close",
						comments: [
							{
								id: 6,
								issue_id: "task-query-2",
								author: "sam",
								text: "query two",
								created_at: "2026-01-01T00:00:00.000Z",
							},
						],
						depends_on_ids: [],
						close_reason: "done",
						usage_totals: { input: 14, output: 6 },
						metadata: { payload: "query-2" },
					}),
				];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "query", params: { query: "status:open" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect(response.data).toEqual([
			{
				id: "task-query-1",
				title: "Issue task-query-1",
				status: "open",
				priority: 4,
				assignee: null,
				dependency_count: 2,
				issue_type: "task",
			},
			{
				id: "task-query-2",
				title: "Issue task-query-2",
				status: "closed",
				priority: 0,
				assignee: "sam",
				dependency_count: 0,
				issue_type: "task",
			},
		]);
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 7)).toBe(true);
		for (const item of response.data ?? []) {
			expect(item).not.toHaveProperty("description");
			expect(item).not.toHaveProperty("acceptance_criteria");
			expect(item).not.toHaveProperty("created_at");
			expect(item).not.toHaveProperty("updated_at");
			expect(item).not.toHaveProperty("comments");
			expect(item).not.toHaveProperty("labels");
			expect(item).not.toHaveProperty("depends_on_ids");
			expect(item).not.toHaveProperty("close_reason");
			expect(item).not.toHaveProperty("usage_totals");
			expect(item).not.toHaveProperty("metadata");
		}
		expect(queryCalls).toEqual([{ query: "status:open", args: [] }]);
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
