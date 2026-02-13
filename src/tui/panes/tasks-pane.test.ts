import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { AgentRegistry } from "../../agents/registry";
import { createEmptyAgentUsage } from "../../agents/types";
import type { TaskStoreClient } from "../../tasks/client";
import type { TaskPollerLike } from "../../tasks/poller";
import type { TaskIssue } from "../../tasks/types";
import { type Region, TasksPane } from "./tasks-pane";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function createTerminalBuffer() {
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
		text: () =>
			[...lines.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, line]) => line)
				.join("\n"),
	};
}

function makeIssue(overrides: Partial<TaskIssue> = {}): TaskIssue {
	return {
		id: "task-1",
		title: "Task 1",
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

describe("TasksPane agent line formatting", () => {
	test("uses pipe separators and fixed-width context/duration fields", () => {
		const issue = makeIssue();
		const pollerEvents = new EventEmitter();
		const poller = {
			readySnapshot: [] as TaskIssue[],
			issuesSnapshot: [issue] as TaskIssue[],
			start: () => {
				// noop
			},
			stop: () => {
				// noop
			},
			setIntervalMs: () => {
				// noop
			},
			on(event: string | symbol, listener: (...args: unknown[]) => void) {
				pollerEvents.on(event, listener);
				return this;
			},
		} as unknown as TaskPollerLike;

		const tasksClient = {
			heartbeat: async () => null,
		} as unknown as TaskStoreClient;
		const registry = new AgentRegistry({ tasksClient, tasksAvailable: false });

		const usage = createEmptyAgentUsage();
		usage.input = 10;
		usage.output = 20;
		usage.totalTokens = 30;
		usage.cost = 0.123;

		registry.register({
			id: "worker-1",
			role: "worker",
			taskId: issue.id,
			tasksAgentId: "agent-1",
			status: "done",
			usage,
			events: [],
			spawnedAt: 1_000,
			lastActivity: 6_000,
			contextWindow: 1_000,
			contextTokens: 30,
			compactionCount: 1,
		});

		const pane = new TasksPane({ poller, registry });
		const terminal = createTerminalBuffer();
		const region: Region = { x: 1, y: 1, width: 220, height: 12 };

		pane.render(terminal.term, region);
		const rendered = stripAnsi(terminal.text());

		expect(rendered).toContain("|  done  |");
		expect(rendered).toContain("C  3%");
		expect(rendered).toContain("T 5s");
		expect(rendered).not.toContain("[  done  ]");
	});
});
