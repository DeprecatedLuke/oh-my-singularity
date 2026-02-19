import { describe, expect, test } from "bun:test";

import type { TaskIssue } from "../../tasks/types";
import { renderTaskTreeLines } from "./task-tree";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeIssue(id: string, overrides: Partial<TaskIssue> & Record<string, unknown> = {}): TaskIssue {
	return {
		id,
		title: id,
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

describe("renderTaskTreeLines", () => {
	test("renders dependency indentation and ready labels", () => {
		const blocker = makeIssue("task-1", { title: "Blocker" });
		const blocked = makeIssue("task-2", {
			title: "Blocked",
			status: "blocked",
			depends_on_ids: ["task-1"],
		});
		const ready = makeIssue("task-3", { title: "Ready" });

		const rendered = renderTaskTreeLines([blocked, ready, blocker], 1000).map(line => ({
			id: line.issue.id,
			depth: line.depth,
			text: stripAnsi(line.text),
		}));

		const blockedLine = rendered.find(line => line.id === "task-2");
		expect(blockedLine?.depth).toBe(1);
		expect(blockedLine?.text).not.toContain("waiting");

		const readyLine = rendered.find(line => line.id === "task-3");
		expect(readyLine?.text).toContain("(ready)");
	});

	test("shows scope in task rows when present", () => {
		const scoped = makeIssue("task-scope", {
			title: "Scoped",
			scope: "small",
		});
		const plain = makeIssue("task-plain", {
			title: "Plain",
		});

		const rendered = renderTaskTreeLines([scoped, plain], 1000).map(line => ({
			id: line.issue.id,
			text: stripAnsi(line.text),
		}));

		const scopedLine = rendered.find(line => line.id === "task-scope");
		expect(scopedLine?.text).toContain("Scoped [small]");
		const plainLine = rendered.find(line => line.id === "task-plain");
		expect(plainLine?.text).not.toContain("Plain [");
	});

	test("excludes closed/done dependencies from tree edges", () => {
		const closedDependency = makeIssue("task-closed", { status: "closed" });
		const doneDependency = makeIssue("task-done", { status: "done" });
		const openDependency = makeIssue("task-open", { status: "in_progress" });
		const blocked = makeIssue("task-main", {
			status: "blocked",
			depends_on_ids: ["task-closed", "task-done", "task-open"],
		});
		const rendered = renderTaskTreeLines([blocked, closedDependency, doneDependency, openDependency], 1000).map(
			line => ({
				id: line.issue.id,
				depth: line.depth,
				text: stripAnsi(line.text),
			}),
		);
		const blockedLine = rendered.find(line => line.id === "task-main");
		expect(blockedLine?.depth).toBe(1);
		expect(blockedLine?.text).not.toContain("waiting");
	});
});
