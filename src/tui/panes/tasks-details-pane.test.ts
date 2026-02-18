import { describe, expect, test } from "bun:test";

import type { TaskStoreClient } from "../../tasks/client";
import type { TaskIssue } from "../../tasks/types";
import { type Region, TasksDetailsPane } from "./tasks-details-pane";

function makeIssue(overrides: Partial<TaskIssue> = {}): TaskIssue {
	return {
		id: "task-1",
		title: "Task 1",
		description: "desc",
		acceptance_criteria: null,
		status: "open",
		priority: 2,
		issue_type: "task",
		labels: [],
		assignee: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		comments: [],
		...overrides,
	};
}

function createTerminalStub() {
	let cursorY = 1;
	const lines = new Map<number, string>();

	const term = ((text: string) => {
		lines.set(cursorY, text);
	}) as unknown as {
		moveTo: (x: number, y: number) => void;
		(text: string): void;
	};

	term.moveTo = (_x: number, y: number) => {
		cursorY = y;
	};

	return {
		term,
		reset: () => lines.clear(),
		text: () =>
			[...lines.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, line]) => line)
				.join("\n"),
	};
}

describe("TasksDetailsPane", () => {
	test("refreshes selected issue details when same selection receives new comments", async () => {
		let selectedIssue = makeIssue();

		const tasksClient = {
			show: async () => ({ ...selectedIssue, comments: [...(selectedIssue.comments ?? [])] }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 30 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		expect(term.text()).toContain("comments: (none)");

		selectedIssue = makeIssue({
			updated_at: "2026-01-01T00:01:00.000Z",
			comments: [
				{
					id: 1,
					issue_id: "task-1",
					author: "oms-worker",
					text: "completion: implemented fix",
					created_at: "2026-01-01T00:01:00.000Z",
				},
			],
		});

		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		expect(rendered).toContain("comments: 1");
		expect(rendered).toContain("completion: implemented fix");
	});

	test("renders references metadata when present", async () => {
		const selectedIssue = makeIssue({
			references: ["task-a", " task-b "],
		});
		const tasksClient = {
			show: async () => ({ ...selectedIssue }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 100, height: 20 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();
		expect(rendered).toContain("references:");
		expect(rendered).toContain("task-a, task-b");
	});

	test("shows per-agent full usage and cost breakdown for selected task", async () => {
		const selectedIssue = makeIssue();
		const tasksClient = {
			show: async () => ({ ...selectedIssue, comments: [...(selectedIssue.comments ?? [])] }),
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const agents = [
			{
				id: "worker-1",
				role: "worker",
				taskId: selectedIssue.id,
				tasksAgentId: "agent-1",
				status: "done",
				usage: {
					input: 12,
					output: 34,
					cacheRead: 5,
					cacheWrite: 2,
					totalTokens: 53,
					cost: 0.321,
				},
				events: [],
				spawnedAt: 1_000,
				lastActivity: 66_000,
				contextWindow: 1_000,
				contextTokens: 45,
				compactionCount: 2,
			},
		];

		const registry = {
			getByTask: () => agents,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
			registry: registry as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 220, height: 40 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();

		expect(rendered).toContain("── Agents ──");
		expect(rendered).toContain("worker");
		expect(rendered).toContain("|  done  |");
		expect(rendered).toContain("↓  12");
		expect(rendered).toContain("↑  34");
		expect(rendered).toContain("R   5");
		expect(rendered).toContain("W   2");
		expect(rendered).toContain("$0.321");
		expect(rendered).toContain("C  5%");
		expect(rendered).toContain("T65s");
		expect(rendered).toContain("C:2");
		expect(rendered).toContain("task duration: 1m 5s");
	});

	test("renders persisted agent history when no live registry agents are present", async () => {
		const selectedIssue = makeIssue();
		const persistedAgentIssue = makeIssue({
			id: "agent-77",
			title: "worker-task-1",
			description: null,
			issue_type: "agent",
			status: "done",
			priority: 0,
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:01:05.000Z",
			comments: [],
			hook_task: selectedIssue.id,
			last_activity: "2026-01-01T00:01:05.000Z",
			agent_state: "done",
			usage_totals: {
				input: 10,
				output: 20,
				cacheRead: 4,
				cacheWrite: 1,
				totalTokens: 35,
				cost: 0.1,
			},
		});

		const tasksClient = {
			show: async () => ({ ...selectedIssue, comments: [...(selectedIssue.comments ?? [])] }),
			list: async () => [persistedAgentIssue],
		} as unknown as TaskStoreClient;

		const tasksPane = {
			getSelectedIssueId: () => selectedIssue.id,
			getSelectedIssue: () => selectedIssue,
		};

		const pane = new TasksDetailsPane({
			tasksClient,
			tasksPane: tasksPane as never,
		});

		const term = createTerminalStub();
		const region: Region = { x: 1, y: 1, width: 220, height: 40 };

		pane.render(term.term, region);
		await Bun.sleep(0);
		term.reset();
		pane.render(term.term, region);
		const rendered = term.text();

		expect(rendered).toContain("agent usage: 1");
		expect(rendered).toContain("task duration: 1m 5s");
		expect(rendered).toContain("── Agents ──");
		expect(rendered).toContain("worker");
		expect(rendered).toContain("|  done  |");
		expect(rendered).toContain("↓  10");
		expect(rendered).toContain("↑  20");
		expect(rendered).toContain("R   4");
		expect(rendered).toContain("W   1");
		expect(rendered).toContain("$0.100");
	});
});
