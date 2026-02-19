import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import { createEmptyAgentUsage } from "../agents/types";
import { DEFAULT_CONFIG } from "../config";
import { AgentLoop } from "../loop/agent-loop";
import { TaskCliError, type TaskStoreClient } from "../tasks/client";
import { TaskPoller } from "../tasks/poller";
import { JsonTaskStore } from "../tasks/store/base";
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
		advanceFastWorkerLifecycle: (opts: unknown) => ({ ok: true, opts }),
		advanceFinisherLifecycle: (opts: unknown) => ({ ok: true, opts }),
		handleFinisherCloseTask: async (opts: unknown) => ({ ok: true, opts }),
		handleFastWorkerCloseTask: async (opts: unknown) => ({ ok: true, opts }),
		handleExternalTaskClose: async (_taskId: string) => {},
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

	test("tasks_request list explicit type override is passed through", async () => {
		const listCalls: Array<readonly string[] | undefined> = [];
		const tasksClient = {
			list: async (args?: readonly string[]) => {
				listCalls.push(args);
				const argList = Array.isArray(args) ? args : [];
				const typeIndex = argList.indexOf("--type");
				const requestedType = typeIndex >= 0 ? (argList[typeIndex + 1] ?? "") : "";
				if (requestedType === "agent") {
					return [
						makeIssue("agent-1", {
							issue_type: "agent",
							status: "in_progress",
						}),
					];
				}
				return [
					makeIssue("task-1", {
						issue_type: "task",
						status: "open",
					}),
				];
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: { type: "tasks_request", action: "list", params: { type: "agent" } },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown[] };

		expect(response.ok).toBe(true);
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual(["agent-1"]);
		expect(listCalls[0]).toEqual(["--type", "agent"]);
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
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 8)).toBe(true);
		expect(listCalls[0]).toEqual(["--type", "task"]);
	});

	test("tasks_request list applies default visibility before limit when top results are terminal", async () => {
		const listCalls: Array<readonly string[] | undefined> = [];
		const terminalIssues = Array.from({ length: 50 }, (_, index) =>
			makeIssue(`agent-${index + 1}`, {
				issue_type: "agent",
				status: "done",
				priority: 0,
			}),
		);
		const openIssue = makeIssue("task-open-visible", {
			status: "open",
			priority: 4,
			issue_type: "task",
			updated_at: "2026-01-02T00:00:00.000Z",
		});
		const tasksClient = {
			list: async (args?: readonly string[]) => {
				listCalls.push(args);
				if (Array.isArray(args) && args.includes("--limit")) return terminalIssues;
				return [...terminalIssues, openIssue];
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
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual([openIssue.id]);
		expect(listCalls[0]).toEqual(["--type", "task"]);
	});

	test("tasks_request create remains visible in default list with real store", async () => {
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-list-visible-test-"));
		try {
			const tasksClient = new JsonTaskStore({
				cwd: process.cwd(),
				sessionDir,
				actor: "oms-main",
			});
			const registry = createRegistry(tasksClient);
			for (let i = 0; i < 50; i += 1) {
				const agentIssue = await tasksClient.create(`Terminal agent ${i + 1}`, null, 0, { type: "agent" });
				await tasksClient.update(agentIssue.id, { newStatus: "done" });
			}

			const openAgent = await tasksClient.create("Open terminal agent", null, 0, { type: "agent" });

			const createResponse = (await handleIpcMessage({
				payload: { type: "tasks_request", action: "create", params: { title: "Fresh open task" } },
				loop: null,
				registry,
				tasksClient,
				systemAgentId: "system",
			})) as { ok: boolean; data?: TaskIssue };
			expect(createResponse.ok).toBe(true);
			const createdTaskId = createResponse.data?.id ?? "";
			expect(createdTaskId).toBeTruthy();

			const listResponse = (await handleIpcMessage({
				payload: { type: "tasks_request", action: "list", params: {} },
				loop: null,
				registry,
				tasksClient,
				systemAgentId: "system",
			})) as { ok: boolean; data?: unknown[] };
			expect(listResponse.ok).toBe(true);
			const listIds = (listResponse.data ?? []).map(item => (item as { id: string }).id);
			expect(listIds).toEqual([createdTaskId]);
			expect(listIds).not.toContain(openAgent.id);
		} finally {
			await fs.rm(sessionDir, { recursive: true, force: true });
		}
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
		expect(listCalls[0]).toEqual(["--status", "done", "--type", "task", "--limit", "50"]);
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

	test("tasks_request search defaults limit to 50 and forwards status", async () => {
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
				params: { query: "alpha", status: "blocked" },
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
					status: "blocked",
					limit: 50,
				},
			},
		]);
	});

	test("tasks_request search forwards null status when status is omitted", async () => {
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
					status: null,
					limit: 50,
				},
			},
		]);
	});

	test("tasks_request search includes closed and terminal statuses by default", async () => {
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
		expect((response.data ?? []).map(item => (item as { id: string }).id)).toEqual([
			"task-open",
			"task-blocked",
			"task-closed",
			"task-done",
			"task-failed",
			"task-dead",
		]);
	});

	test("tasks_request search includeClosed=true still returns closed and terminal statuses", async () => {
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
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 8)).toBe(true);
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
				id: "task-search-done",
				title: "Issue task-search-done",
				status: "done",
				priority: 2,
				assignee: null,
				dependency_count: 0,
				issue_type: "task",
			},
			{
				id: "task-search-closed",
				title: "Issue task-search-closed",
				status: "closed",
				priority: 4,
				assignee: null,
				dependency_count: 0,
				issue_type: "task",
			},
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
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 8)).toBe(true);
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
					status: null,
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
		expect((response.data ?? []).every(item => Object.keys(item as Record<string, unknown>).length === 8)).toBe(true);
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

	test("tasks_request close notifies loop to cleanup external merge queue state", async () => {
		const externalCloseCalls: string[] = [];
		const loop = createLoopStub({
			handleExternalTaskClose: async (taskId: string) => {
				externalCloseCalls.push(taskId);
			},
		});
		const tasksClient = {
			close: async (_taskId: string, _reason?: string) => {},
			show: async (taskId: string) => makeIssue(taskId, { status: "closed" }),
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = await handleIpcMessage({
			payload: { type: "tasks_request", action: "close", params: { id: "task-closed", reason: "manual" } },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(response).toEqual(expect.objectContaining({ ok: true }));
		expect(externalCloseCalls).toEqual(["task-closed"]);
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

	test("tasks_request create forwards depends_on and references values", async () => {
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
				params: { title: "Single dependency", depends_on: "task-100", references: "task-50" },
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
					references: ["task-50", "task-51"],
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

		const firstOptions = createCalls[0]?.options as
			| { depends_on?: string | string[]; references?: string | string[] }
			| undefined;
		const secondOptions = createCalls[1]?.options as
			| { depends_on?: string | string[]; references?: string | string[] }
			| undefined;
		expect(firstOptions?.depends_on).toBe("task-100");
		expect(firstOptions?.references).toBe("task-50");
		expect(secondOptions?.depends_on).toEqual(["task-100", "task-101"]);
		expect(secondOptions?.references).toEqual(["task-50", "task-51"]);
	});

	test("tasks_request update forwards references patch values", async () => {
		const updateCalls: Array<{ id: string; patch: unknown }> = [];
		const showCalls: string[] = [];
		const tasksClient = {
			update: async (id: string, patch: unknown) => {
				updateCalls.push({ id, patch });
				return null;
			},
			show: async (id: string) => {
				showCalls.push(id);
				return makeIssue(id);
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const arrayResponse = await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "update",
				params: { id: "task-1", references: ["task-8", "task-9"] },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(arrayResponse).toEqual(expect.objectContaining({ ok: true }));

		const stringResponse = await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "update",
				params: { id: "task-1", references: "task-10" },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(stringResponse).toEqual(expect.objectContaining({ ok: true }));

		const clearResponse = await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "update",
				params: { id: "task-1", references: "" },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(clearResponse).toEqual(expect.objectContaining({ ok: true }));

		const firstPatch = updateCalls[0]?.patch as { references?: string | string[] } | undefined;
		const secondPatch = updateCalls[1]?.patch as { references?: string | string[] } | undefined;
		const thirdPatch = updateCalls[2]?.patch as { references?: string | string[] } | undefined;
		expect(firstPatch?.references).toEqual(["task-8", "task-9"]);
		expect(secondPatch?.references).toBe("task-10");
		expect(thirdPatch?.references).toEqual([]);
		expect(showCalls).toEqual(["task-1", "task-1", "task-1"]);
	});

	test("tasks_request supports defaultTaskId fallback", async () => {
		const commentCalls: Array<{ id: string; text: string; actor?: string }> = [];
		const tasksClient = {
			comment: async (id: string, text: string, actor?: string) => {
				commentCalls.push({ id, text, actor });
				return { id, text };
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const response = (await handleIpcMessage({
			payload: {
				type: "tasks_request",
				action: "comment_add",
				defaultTaskId: "task-55",
				actor: "oms-singularity",
				params: { text: "note" },
			},
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; data?: unknown };

		expect(response.ok).toBe(true);
		expect(commentCalls).toEqual([{ id: "task-55", text: "note", actor: "oms-singularity" }]);
	});

	test("comment_add from singularity interrupts a running worker through poller activity", async () => {
		const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-comment-actor-test-"));
		let poller: TaskPoller | null = null;
		try {
			const tasksClient = new JsonTaskStore({
				cwd: process.cwd(),
				sessionDir,
				actor: "oms-main",
			});
			const task = await tasksClient.create("Interrupt target");
			const registry = createRegistry(tasksClient);
			const loop = new AgentLoop({
				tasksClient,
				registry,
				scheduler: {
					getInProgressTasksWithoutAgent: async () => [],
					getNextTasks: async () => [],
					findTasksUnblockedBy: async () => [],
				} as never,
				spawner: {} as never,
				config: { ...DEFAULT_CONFIG, pollIntervalMs: 50, steeringIntervalMs: 50 },
			});
			(loop as unknown as { running: boolean; paused: boolean }).running = true;
			(loop as unknown as { paused: boolean }).paused = false;

			const interruptPrompts: string[] = [];
			const {
				promise: interruptPromise,
				resolve: resolveInterrupt,
				reject: rejectInterrupt,
			} = Promise.withResolvers<void>();

			(
				loop as unknown as {
					pipelineManager: {
						spawnTaskWorker: (
							spawnTask: TaskIssue,
							opts?: { claim?: boolean; kickoffMessage?: string | null },
						) => Promise<unknown>;
					};
				}
			).pipelineManager.spawnTaskWorker = async (spawnTask: TaskIssue) => {
				const workerRpc = new OmsRpcClient();
				(workerRpc as unknown as { suppressNextAgentEnd: () => void }).suppressNextAgentEnd = () => {};
				(workerRpc as unknown as { abortAndPrompt: (message: string) => Promise<void> }).abortAndPrompt = async (
					message: string,
				) => {
					interruptPrompts.push(message);
					resolveInterrupt();
				};
				return registry.register({
					id: "worker-comment-actor",
					role: "worker",
					taskId: spawnTask.id,
					tasksAgentId: "worker-comment-actor",
					status: "running",
					usage: createEmptyAgentUsage(),
					events: [],
					spawnedAt: 1,
					lastActivity: 2,
					rpc: workerRpc,
				});
			};

			await loop.spawnAgentBySingularity({ role: "worker", taskId: task.id });
			expect(registry.getActiveByTask(task.id).some(agent => agent.role === "worker")).toBe(true);

			poller = new TaskPoller({
				client: tasksClient,
				intervalMs: 50,
				includeIssueList: false,
				includeActivity: true,
			});
			poller.on("activity", activity => {
				for (const event of activity) {
					if (!event || event.type !== "comment_add") continue;
					const taskId = typeof event.issue_id === "string" ? event.issue_id : "";
					const eventData =
						event.data && typeof event.data === "object" && !Array.isArray(event.data)
							? (event.data as Record<string, unknown>)
							: null;
					const commentText = typeof eventData?.text === "string" ? eventData.text : "";
					if (!taskId || !commentText) continue;
					const activeAgents = registry.getActiveByTask(taskId);
					if (activeAgents.length === 0) continue;
					const commentActor = typeof event.actor === "string" ? event.actor.trim() : "";
					if (commentActor.startsWith("oms-") && commentActor !== "oms-singularity") continue;
					void loop.interruptAgent(taskId, commentText).catch(rejectInterrupt);
				}
			});
			poller.start();
			const response = (await handleIpcMessage({
				payload: {
					type: "tasks_request",
					action: "comment_add",
					actor: "oms-singularity",
					params: { id: task.id, text: "urgent guidance" },
				},
				loop: null,
				registry,
				tasksClient,
				systemAgentId: "system",
			})) as { ok: boolean; data?: unknown };
			expect(response.ok).toBe(true);
			await Promise.race([
				interruptPromise,
				Bun.sleep(1_000).then(() => {
					throw new Error("Timed out waiting for worker interrupt after comment_add");
				}),
			]);

			expect(interruptPrompts).toEqual(["[URGENT MESSAGE]\n\nurgent guidance"]);
			const worker = registry.getActiveByTask(task.id).find(agent => agent.role === "worker");
			const sawInterruptLog = worker?.events.some(event => {
				if (event.type !== "log") return false;
				const message = typeof event.message === "string" ? event.message : "";
				return message.includes("Interrupt from singularity");
			});
			expect(sawInterruptLog).toBe(true);
		} finally {
			poller?.stop();
			await fs.rm(sessionDir, { recursive: true, force: true });
		}
	});

	test("issuer/fast-worker/finisher lifecycle IPC and fast_worker_close_task return unavailable when loop is missing", async () => {
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		const issuerResponse = await handleIpcMessage({
			payload: { type: "issuer_advance_lifecycle", taskId: "task-1", action: "next" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const fastWorkerResponse = await handleIpcMessage({
			payload: { type: "fast_worker_advance_lifecycle", taskId: "task-1", action: "done" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const fastWorkerCloseResponse = await handleIpcMessage({
			payload: { type: "fast_worker_close_task", taskId: "task-1", reason: "done", agentId: "fast-1" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const finisherResponse = await handleIpcMessage({
			payload: { type: "finisher_advance_lifecycle", taskId: "task-1", action: "worker" },
			loop: null,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(issuerResponse).toEqual({ ok: false, summary: "Agent loop unavailable" });
		expect(fastWorkerResponse).toEqual({ ok: false, summary: "Agent loop unavailable" });
		expect(fastWorkerCloseResponse).toEqual({ ok: false, summary: "Agent loop unavailable" });
		expect(finisherResponse).toEqual({ ok: false, summary: "Agent loop unavailable" });
	});

	test("issuer/fast-worker/finisher lifecycle IPC and close-task IPC delegate to loop", async () => {
		const calls: {
			issuer: unknown[];
			fastWorkerAdvance: unknown[];
			fastWorkerClose: unknown[];
			finisherAdvance: unknown[];
			finisherClose: unknown[];
		} = {
			issuer: [],
			fastWorkerAdvance: [],
			fastWorkerClose: [],
			finisherAdvance: [],
			finisherClose: [],
		};
		const loop = createLoopStub({
			advanceIssuerLifecycle: (opts: unknown) => {
				calls.issuer.push(opts);
				return { ok: true, kind: "issuer" };
			},
			advanceFastWorkerLifecycle: (opts: unknown) => {
				calls.fastWorkerAdvance.push(opts);
				return { ok: true, kind: "fast-worker-advance" };
			},
			handleFastWorkerCloseTask: async (opts: unknown) => {
				calls.fastWorkerClose.push(opts);
				return { ok: true, kind: "fast-worker-close" };
			},
			advanceFinisherLifecycle: (opts: unknown) => {
				calls.finisherAdvance.push(opts);
				return { ok: true, kind: "finisher-advance" };
			},
			handleFinisherCloseTask: async (opts: unknown) => {
				calls.finisherClose.push(opts);
				return { ok: true, kind: "finisher-close" };
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
		const fastWorkerAdvance = await handleIpcMessage({
			payload: {
				type: "fast_worker_advance_lifecycle",
				taskId: "task-1",
				action: "escalate",
				message: "needs issuer",
				reason: "too broad",
				agentId: "fast-1",
			},
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const fastWorkerClose = await handleIpcMessage({
			payload: { type: "fast_worker_close_task", taskId: "task-1", reason: "done", agentId: "fast-1" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const finisherAdvance = await handleIpcMessage({
			payload: {
				type: "finisher_advance_lifecycle",
				taskId: "task-1",
				action: "worker",
				message: "resume",
				reason: "missing impl",
				agentId: "fin-1",
			},
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		const finisherClose = await handleIpcMessage({
			payload: { type: "finisher_close_task", taskId: "task-1", reason: "done", agentId: "fin-1" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(issuer).toEqual({ ok: true, kind: "issuer" });
		expect(fastWorkerAdvance).toEqual({ ok: true, kind: "fast-worker-advance" });
		expect(fastWorkerClose).toEqual({ ok: true, kind: "fast-worker-close" });
		expect(finisherAdvance).toEqual({ ok: true, kind: "finisher-advance" });
		expect(finisherClose).toEqual({ ok: true, kind: "finisher-close" });
		expect(calls.issuer).toHaveLength(1);
		expect(calls.fastWorkerAdvance).toHaveLength(1);
		expect(calls.fastWorkerClose).toHaveLength(1);
		expect(calls.finisherAdvance).toHaveLength(1);
		expect(calls.finisherClose).toHaveLength(1);
	});

	test("broadcast validates message and delegates non-empty", async () => {
		const sent: string[] = [];
		const loop = createLoopStub({
			broadcastToWorkers: async (message: string) => {
				sent.push(message);
			},
		});
		const tasksClient = {} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		const empty = await handleIpcMessage({
			payload: { type: "broadcast", message: "   " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(empty).toEqual({ ok: false, error: "broadcast_to_workers: message is required" });

		const ok = await handleIpcMessage({
			payload: { type: "broadcast", message: "ship it" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(ok).toEqual({ ok: true });
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
		const tasksClient = {
			show: async (id: string) => makeIssue(id),
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker-task-1",
			role: "worker",
			taskId: "task-1",
			tasksAgentId: "worker-task-1",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});

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

	test("interrupt_agent returns error for nonexistent task and does not interrupt", async () => {
		const interruptCalls: Array<{ taskId: string; message: string }> = [];
		const seenTasks: string[] = [];
		const loop = createLoopStub({
			interruptAgent: async (taskId: string, message: string) => {
				interruptCalls.push({ taskId, message });
				return true;
			},
		});
		const tasksClient = {
			show: async (id: string) => {
				seenTasks.push(id);
				throw new TaskCliError({
					message: `tasks command failed (exit 1): tasks --quiet --actor oms show ${id}`,
					cmd: ["tasks", "show", id],
					cwd: process.cwd(),
					exitCode: 1,
					stdout: "",
					stderr: "issue not found",
				});
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const missing = await handleIpcMessage({
			payload: { type: "interrupt_agent", taskId: "task-missing", message: "stop now" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(seenTasks).toEqual(["task-missing"]);
		expect(missing).toEqual({ ok: false, error: "interrupt_agent: task task-missing does not exist" });
		expect(interruptCalls).toHaveLength(0);
	});

	test("steer_agent returns error for nonexistent task before active-agent checks", async () => {
		const steerCalls: Array<{ taskId: string; message: string }> = [];
		const seenTasks: string[] = [];
		const loop = createLoopStub({
			steerAgent: async (taskId: string, message: string) => {
				steerCalls.push({ taskId, message });
				return true;
			},
		});
		const tasksClient = {
			show: async (id: string) => {
				seenTasks.push(id);
				throw new TaskCliError({
					message: `tasks command failed (exit 1): tasks --quiet --actor oms show ${id}`,
					cmd: ["tasks", "show", id],
					cwd: process.cwd(),
					exitCode: 1,
					stdout: "",
					stderr: "issue not found",
				});
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const missing = await handleIpcMessage({
			payload: { type: "steer_agent", taskId: "task-missing", message: "keep going" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(seenTasks).toEqual(["task-missing"]);
		expect(missing).toEqual({ ok: false, error: "steer_agent: task task-missing does not exist" });
		expect(steerCalls).toHaveLength(0);
	});

	test("steer_agent returns errors for no active agent and finisher-only tasks", async () => {
		const steerCalls: Array<{ taskId: string; message: string }> = [];
		const loop = createLoopStub({
			steerAgent: async (taskId: string, message: string) => {
				steerCalls.push({ taskId, message });
				return true;
			},
		});
		const tasksClient = {
			show: async (id: string) => makeIssue(id),
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const noActive = await handleIpcMessage({
			payload: { type: "steer_agent", taskId: "task-steer", message: "keep going" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(noActive).toEqual({
			ok: false,
			error: "steer_agent: no active agent for task task-steer (current active agents: none)",
		});
		expect(steerCalls).toHaveLength(0);

		registry.register({
			id: "finisher-task-steer",
			role: "finisher",
			taskId: "task-steer",
			tasksAgentId: "finisher-task-steer",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});

		const finisherOnly = await handleIpcMessage({
			payload: { type: "steer_agent", taskId: "task-steer", message: "keep going" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(finisherOnly).toEqual({
			ok: false,
			error: "steer_agent: cannot steer finisher agent on task task-steer (current active roles: finisher)",
		});
		expect(steerCalls).toHaveLength(0);

		registry.register({
			id: "worker-task-steer",
			role: "worker",
			taskId: "task-steer",
			tasksAgentId: "worker-task-steer",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 3,
		});

		const ok = await handleIpcMessage({
			payload: { type: "steer_agent", taskId: " task-steer ", message: " keep going " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(ok).toEqual({ ok: true });
		expect(steerCalls).toEqual([{ taskId: "task-steer", message: "keep going" }]);
	});

	test("replace_agent returns errors for no active agent and finisher-only tasks", async () => {
		const replaceCalls: unknown[] = [];
		const loop = createLoopStub({
			spawnAgentBySingularity: async (opts: unknown) => {
				replaceCalls.push(opts);
			},
		});
		const tasksClient = {
			show: async (id: string) => makeIssue(id),
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const noActive = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: "task-replace", context: "ctx" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(noActive).toEqual({
			ok: false,
			error: "replace_agent: no active agent for task task-replace (current active agents: none)",
		});
		expect(replaceCalls).toHaveLength(0);

		registry.register({
			id: "finisher-task-replace",
			role: "finisher",
			taskId: "task-replace",
			tasksAgentId: "finisher-task-replace",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});

		const finisherOnly = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: "task-replace", context: "ctx" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(finisherOnly).toEqual({
			ok: false,
			error: "replace_agent: cannot replace finisher agent on task task-replace (finisher manages its own lifecycle; current active roles: finisher)",
		});
		expect(replaceCalls).toHaveLength(0);

		registry.register({
			id: "worker-task-replace",
			role: "worker",
			taskId: "task-replace",
			tasksAgentId: "worker-task-replace",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 3,
		});

		const ok = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: " task-replace ", context: " ctx " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(ok).toEqual({ ok: true });
		expect(replaceCalls).toEqual([{ role: "worker", taskId: "task-replace", context: "ctx" }]);
	});

	test("replace_agent returns error for nonexistent task and does not spawn", async () => {
		const replaceCalls: unknown[] = [];
		const seenTasks: string[] = [];
		const loop = createLoopStub({
			spawnAgentBySingularity: async (opts: unknown) => {
				replaceCalls.push(opts);
			},
		});
		const tasksClient = {
			show: async (id: string) => {
				seenTasks.push(id);
				throw new TaskCliError({
					message: `tasks command failed (exit 1): tasks --quiet --actor oms show ${id}`,
					cmd: ["tasks", "show", id],
					cwd: process.cwd(),
					exitCode: 1,
					stdout: "",
					stderr: "issue not found",
				});
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);

		const missing = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: "task-missing", context: "ctx" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(seenTasks).toEqual(["task-missing"]);
		expect(missing).toEqual({ ok: false, error: "replace_agent: task task-missing does not exist" });
		expect(replaceCalls).toHaveLength(0);
	});

	test("replace_agent returns error for closed tasks and does not spawn", async () => {
		const replaceCalls: unknown[] = [];
		const loop = createLoopStub({
			spawnAgentBySingularity: async (opts: unknown) => {
				replaceCalls.push(opts);
			},
		});
		const tasksClient = {
			show: async (id: string) => makeIssue(id, { status: "closed" }),
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker-task-closed",
			role: "worker",
			taskId: "task-closed",
			tasksAgentId: "worker-task-closed",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});

		const closed = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: "task-closed", context: "ctx" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});

		expect(closed).toEqual({ ok: false, error: "Task is closed. Create a new task instead." });
		expect(replaceCalls).toHaveLength(0);
	});
	test("replace_agent returns error when loop is paused", async () => {
		const replaceCalls: unknown[] = [];
		const loop = createLoopStub({
			isPaused: () => true,
			spawnAgentBySingularity: async (opts: unknown) => {
				replaceCalls.push(opts);
			},
		});
		const seenTasks: string[] = [];
		const tasksClient = {
			show: async (id: string) => {
				seenTasks.push(id);
				return makeIssue(id, { status: "blocked" });
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker-task-paused",
			role: "worker",
			taskId: "task-paused",
			tasksAgentId: "worker-task-paused",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 2,
		});
		const paused = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: "task-paused", context: "ctx" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(paused).toEqual({ ok: false, error: "replace_agent: agent loop is paused" });
		expect(seenTasks).toEqual([]);
		expect(replaceCalls).toHaveLength(0);
	});

	test("replace_agent unblocks blocked tasks and spawns replacement", async () => {
		const replaceCalls: Array<{ taskId: string; kickoff: string | null }> = [];
		const updateStatusCalls: Array<{ taskId: string; status: string }> = [];
		const showCalls: string[] = [];
		const scheduler = {
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
			findTasksUnblockedBy: async () => [],
		} as never;
		const tasksClient = {
			show: async (id: string) => {
				showCalls.push(id);
				return makeIssue(id, { status: "blocked" });
			},
			updateStatus: async (taskId: string, status: string) => {
				updateStatusCalls.push({ taskId, status });
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker-task-blocked",
			role: "worker",
			taskId: "task-blocked",
			tasksAgentId: "worker-task-blocked",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 3,
		});
		const loop = new AgentLoop({
			tasksClient,
			registry,
			scheduler,
			spawner: {} as never,
			config: { ...DEFAULT_CONFIG, pollIntervalMs: 50, steeringIntervalMs: 50 },
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { running: boolean; paused: boolean }).paused = false;
		(
			loop as unknown as {
				pipelineManager: {
					spawnTaskWorker: (task: { id: string }, opts?: { kickoffMessage?: string | null }) => Promise<unknown>;
				};
			}
		).pipelineManager.spawnTaskWorker = async (task: { id: string }, opts?: { kickoffMessage?: string | null }) => {
			replaceCalls.push({ taskId: task.id, kickoff: opts?.kickoffMessage ?? null });
			return {
				id: `worker:${task.id}:spawned`,
				role: "worker",
				taskId: task.id,
				tasksAgentId: "agent-spawned",
				status: "working",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: 1,
				lastActivity: Date.now(),
			};
		};

		const ok = await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: " task-blocked ", context: " ctx " },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		});
		expect(ok).toEqual({ ok: true });
		expect(showCalls).toEqual(["task-blocked", "task-blocked", "task-blocked"]);
		expect(updateStatusCalls).toEqual([{ taskId: "task-blocked", status: "in_progress" }]);
		expect(replaceCalls).toEqual([{ taskId: "task-blocked", kickoff: "ctx" }]);
	});

	test("replace_agent returns error when blocked task cannot be unblocked", async () => {
		const replaceCalls: unknown[] = [];
		const scheduler = {
			getInProgressTasksWithoutAgent: async () => [],
			getNextTasks: async () => [],
			findTasksUnblockedBy: async () => [],
		} as never;
		const tasksClient = {
			show: async (id: string) => makeIssue(id, { status: "blocked" }),
			updateStatus: async () => {
				throw new Error("cannot write status");
			},
		} as unknown as TaskStoreClient;
		const registry = createRegistry(tasksClient);
		registry.register({
			id: "worker-task-blocked-fail",
			role: "worker",
			taskId: "task-blocked-fail",
			tasksAgentId: "worker-task-blocked-fail",
			status: "running",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 1,
			lastActivity: 3,
		});
		const loop = new AgentLoop({
			tasksClient,
			registry,
			scheduler,
			spawner: {} as never,
			config: { ...DEFAULT_CONFIG, pollIntervalMs: 50, steeringIntervalMs: 50 },
		});
		(loop as unknown as { running: boolean; paused: boolean }).running = true;
		(loop as unknown as { running: boolean; paused: boolean }).paused = false;
		(
			loop as unknown as {
				pipelineManager: {
					spawnTaskWorker: (_task: { id: string }, _opts?: { kickoffMessage?: string | null }) => Promise<unknown>;
				};
			}
		).pipelineManager.spawnTaskWorker = async () => {
			replaceCalls.push(true);
			return {
				id: "worker:task-blocked-fail:spawned",
				role: "worker",
				taskId: "task-blocked-fail",
				tasksAgentId: "worker-task-blocked-fail-spawned",
				status: "working",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt: 1,
				lastActivity: Date.now(),
			};
		};

		const blocked = (await handleIpcMessage({
			payload: { type: "replace_agent", role: "worker", taskId: "task-blocked-fail", context: "ctx" },
			loop: loop as never,
			registry,
			tasksClient,
			systemAgentId: "system",
		})) as { ok: boolean; error?: string };
		expect(blocked.ok).toBe(false);
		expect(blocked.error).toContain("replace_agent: failed to spawn replacement for task task-blocked-fail");
		expect(replaceCalls).toHaveLength(0);
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
