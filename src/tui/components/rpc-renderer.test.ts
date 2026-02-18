import { describe, expect, test } from "bun:test";

import { getRenderedRpcLines } from "./rpc-renderer";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderWithWidth(events: readonly unknown[], width: number): string {
	const lines = getRenderedRpcLines(events, width);
	return stripAnsi(lines.join("\n"));
}
function render(events: readonly unknown[]): string {
	return renderWithWidth(events, 160);
}

describe("rpc renderer tool and wake rendering", () => {
	test("renders tasks list results as formatted rows instead of raw JSON", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "tasks",
					args: { action: "list", limit: 5 },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "tasks",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: 'tasks list: ok\n[{"id":"task-1","title":"Validate task IDs","status":"open","priority":2,"dependency_count":0}]',
							},
						],
						details: [
							{ id: "task-1", title: "Validate task IDs", status: "open", priority: 2, dependency_count: 0 },
						],
					},
				},
			},
		]);

		expect(output).toContain("tasks");
		expect(output).toContain("list");
		expect(output).toContain("list (1)");
		expect(output).toContain("task-1");
		expect(output).not.toContain('{"id":"task-1"');
		expect(output).toContain("─── list (1)");
		expect(output).not.toContain("│ │");
	});

	test("renders streaming tasks tool-call args as wrapped fields", () => {
		const output = renderWithWidth(
			[
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_start",
							toolCall: {
								id: "call-stream-1",
								name: "tasks",
								arguments: { action: "create" },
							},
						},
					},
				},
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_delta",
							toolCall: {
								id: "call-stream-1",
								arguments: {
									title: "Render progressive call preview",
									description:
										"This description should wrap across terminal width while the model streams arguments.",
									priority: 2,
									labels: ["enhancement", "ui"],
									depends_on: ["task-11", "task-12"],
								},
							},
						},
					},
				},
			],
			72,
		);

		expect(output).toContain("action: create");
		expect(output).toContain("title: Render progressive call preview");
		expect(output).toContain("description:");
		expect(output).toContain("labels: enhancement, ui");
		expect(output).toContain("depends_on: task-11, task-12");
		expect(output).not.toContain("(no output)");
	});

	test("collapses streaming tasks tool-call field view after toolcall_end", () => {
		const output = renderWithWidth(
			[
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_start",
							toolCall: {
								id: "call-stream-2",
								name: "tasks",
								arguments: { action: "create" },
							},
						},
					},
				},
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_delta",
							toolCall: {
								id: "call-stream-2",
								arguments: {
									title: "Render progressive call preview",
									description:
										"This description should wrap across terminal width while the model streams arguments.",
									priority: 2,
									labels: ["enhancement", "ui"],
								},
							},
						},
					},
				},
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_end",
							toolCall: {
								id: "call-stream-2",
								name: "tasks",
								arguments: {
									action: "create",
									title: "Render progressive call preview",
									description:
										"This description should wrap across terminal width while the model streams arguments.",
									priority: 2,
									labels: ["enhancement", "ui"],
								},
							},
						},
					},
				},
			],
			72,
		);

		expect(output).toContain("tasks");
		expect(output).toContain("create");
		expect(output).toContain("(no output)");
		expect(output).not.toContain("description:");
		expect(output).not.toContain("labels: enhancement, ui");
	});

	test("combines string toolcall deltas into progressive tasks args", () => {
		const output = renderWithWidth(
			[
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_start",
							toolCall: {
								id: "call-stream-3",
								name: "tasks",
								arguments: "",
							},
						},
					},
				},
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_delta",
							toolCall: { id: "call-stream-3", name: "tasks" },
							delta: '{"action":"create","title":"Streamed title"',
						},
					},
				},
				{
					type: "rpc",
					data: {
						type: "message_update",
						assistantMessageEvent: {
							type: "toolcall_delta",
							toolCall: { id: "call-stream-3", name: "tasks" },
							delta: ',"description":"Chunked description"}',
						},
					},
				},
			],
			76,
		);

		expect(output).toContain("action: create");
		expect(output).toContain("title: Streamed title");
		expect(output).toContain("description: Chunked description");
	});

	test("renders tasks search results in compact formatted table", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-1b",
					toolName: "tasks",
					args: { action: "search", query: "validate" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-1b",
					toolName: "tasks",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: 'tasks search: ok\n[{"id":"task-1","title":"Validate task IDs","status":"open","priority":2,"dependency_count":1},{"id":"task-2","title":"Render boxes","status":"in_progress","priority":1,"dependency_count":0}]',
							},
						],
						details: [
							{ id: "task-1", title: "Validate task IDs", status: "open", priority: 2, dependency_count: 1 },
							{ id: "task-2", title: "Render boxes", status: "in_progress", priority: 1, dependency_count: 0 },
						],
					},
				},
			},
		]);

		expect(output).toContain("search (2)");
		expect(output).toContain("task-1");
		expect(output).toContain("task-2");
		expect(output).not.toContain('"id":"task-1"');
	});

	test("renders tasks show details as a compact bordered card", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-show-1",
					toolName: "tasks",
					args: { action: "show", id: "task-show-1" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-show-1",
					toolName: "tasks",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: 'tasks show: ok\n{"id":"task-show-1","title":"Validate renderer","status":"in_progress","priority":2,"description":"Render compact task cards in TUI","depends_on_ids":["task-0"],"references":["task-ref-1"]}',
							},
						],
						details: {
							id: "task-show-1",
							title: "Validate renderer",
							status: "in_progress",
							priority: 2,
							description: "Render compact task cards in TUI",
							depends_on_ids: ["task-0"],
							references: ["task-ref-1"],
						},
					},
				},
			},
		]);

		expect(output).toContain("task: task-show-1");
		expect(output).toContain("status:");
		expect(output).toContain("deps:task-0");
		expect(output).toContain("refs:task-ref-1");
		expect(output).toContain("Render compact task cards in TUI");
		expect(output).not.toContain('"id":"task-show-1"');
	});

	test("renders tasks comments action as compact formatted list", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-comments-1",
					toolName: "tasks",
					args: { action: "comments", id: "task-1" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-comments-1",
					toolName: "tasks",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: 'tasks comments: ok\n[{"id":1,"issue_id":"task-1","author":"alice","text":"Needs retry","created_at":"2026-02-16T12:00:00.000Z"},{"id":2,"issue_id":"task-1","author":"bob","text":"Looks good now","created_at":"2026-02-16T13:00:00.000Z"}]',
							},
						],
						details: [
							{
								id: 1,
								issue_id: "task-1",
								author: "alice",
								text: "Needs retry",
								created_at: "2026-02-16T12:00:00.000Z",
							},
							{
								id: 2,
								issue_id: "task-1",
								author: "bob",
								text: "Looks good now",
								created_at: "2026-02-16T13:00:00.000Z",
							},
						],
					},
				},
			},
		]);

		expect(output).toContain("comments (2)");
		expect(output).toContain("alice");
		expect(output).toContain("Needs retry");
		expect(output).not.toContain('"issue_id":"task-1"');
	});

	test("renders tasks no-output and error responses", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-2",
					toolName: "tasks",
					args: { action: "comment_add", id: "task-1" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-2",
					toolName: "tasks",
					isError: false,
					result: {
						content: [{ type: "text", text: "tasks comment_add: ok (no output)" }],
						details: null,
					},
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-3",
					toolName: "tasks",
					args: { action: "close" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-3",
					toolName: "tasks",
					isError: true,
					result: {
						content: [{ type: "text", text: "tasks: action not permitted: close (role=worker)" }],
						details: { action: "close" },
					},
				},
			},
		]);

		expect(output).toContain("comment_add");
		expect(output).toContain("tasks comment_add: ok (no output)");
		expect(output).toContain("tasks: action not permitted: close (role=worker)");
	});

	test("renders tasks comment_add as a concise count summary", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-comment-add-1",
					toolName: "tasks",
					args: { action: "comment_add", id: "task-1", text: "Looks good" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-comment-add-1",
					toolName: "tasks",
					isError: false,
					result: {
						content: [{ type: "text", text: "\n" }],
						details: { id: "task-1" },
					},
				},
			},
		]);

		expect(output).toContain("Added comment (1)");
		expect(output).not.toContain("Added comment to task-1");
	});

	test("renders summaries for terse tasks/start_tasks results and empty payloads", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-4",
					toolName: "tasks",
					args: { action: "create", title: "Add feedback" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-4",
					toolName: "tasks",
					isError: false,
					result: {
						content: [{ type: "text", text: "\n" }],
						details: { id: "task-9", title: "Add feedback" },
					},
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-5",
					toolName: "tasks",
					args: { action: "comment_add", id: "task-9" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-5",
					toolName: "tasks",
					isError: false,
					result: {
						content: [{ type: "text", text: "   " }],
						details: null,
					},
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-6",
					toolName: "start_tasks",
					args: { count: 2 },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-6",
					toolName: "start_tasks",
					isError: false,
					result: undefined,
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-7",
					toolName: "start_tasks",
					args: { count: 2 },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-7",
					toolName: "start_tasks",
					isError: false,
					result: { spawned: 2, taskIds: ["task-a", "task-b"] },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-8",
					toolName: "custom_tool",
					args: {},
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-8",
					toolName: "custom_tool",
					isError: false,
					result: undefined,
				},
			},
		]);

		expect(output).toContain("task: task-9");
		expect(output).toContain("tasks comment_add: ok (no output)");
		expect(output).toContain("Started task spawning");
		expect(output).toContain("spawned=2");
		expect(output).toContain("(no output)");
	});

	test("renders initial prompt events as task prompt blocks", () => {
		const output = render([{ type: "initial_prompt", text: "Follow instructions exactly", ts: 1 }]);

		expect(output).toContain("Task Prompt: Follow instructions exactly");
		expect(output).not.toContain("Input: Follow instructions exactly");
	});

	test("renders interrupt prompt between interrupted and resumed turns when prompt role is missing", () => {
		const output = render([
			{ type: "rpc", data: { type: "turn_start", turnIndex: 0 } },
			{ type: "rpc", data: { type: "message_update", assistantMessageEvent: { type: "text_start" } } },
			{
				type: "rpc",
				data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "before interrupt" } },
			},
			{ type: "rpc", data: { type: "agent_end" } },
			{ type: "rpc", data: { type: "turn_start", turnIndex: 1 } },
			{
				type: "rpc",
				data: {
					type: "message_start",
					message: { content: [{ type: "text", text: "[URGENT MESSAGE]" }] },
				},
			},
			{
				type: "rpc",
				data: {
					type: "message_end",
					message: { content: [{ type: "text", text: "[URGENT MESSAGE]" }] },
				},
			},
			{ type: "rpc", data: { type: "turn_start", turnIndex: 2 } },
			{ type: "rpc", data: { type: "message_update", assistantMessageEvent: { type: "text_start" } } },
			{
				type: "rpc",
				data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "after interrupt" } },
			},
		]);

		expect(output).toContain("Turn 1");
		expect(output).toContain("before interrupt");
		expect(output).toContain("Turn 2");
		expect(output).toContain("Input: [URGENT MESSAGE]");
		expect(output).toContain("Turn 3");
		expect(output).toContain("after interrupt");
		expect(output).not.toContain("before interruptafter interrupt");

		const beforeIdx = output.indexOf("before interrupt");
		const interruptIdx = output.indexOf("Input: [URGENT MESSAGE]");
		const afterIdx = output.indexOf("after interrupt");
		expect(beforeIdx).toBeGreaterThanOrEqual(0);
		expect(interruptIdx).toBeGreaterThan(beforeIdx);
		expect(afterIdx).toBeGreaterThan(interruptIdx);
	});

	test("renders interrupt prompt and preserves turn split when prompt arrives as message_end only", () => {
		const output = render([
			{ type: "rpc", data: { type: "turn_start", turnIndex: 0 } },
			{ type: "rpc", data: { type: "message_update", assistantMessageEvent: { type: "text_start" } } },
			{
				type: "rpc",
				data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "before interrupt" } },
			},
			{ type: "rpc", data: { type: "agent_end" } },
			{ type: "rpc", data: { type: "turn_start", turnIndex: 1 } },
			{
				type: "rpc",
				data: {
					type: "message_end",
					message: { content: [{ type: "text", text: "[URGENT MESSAGE]" }] },
				},
			},
			{ type: "rpc", data: { type: "turn_start", turnIndex: 2 } },
			{ type: "rpc", data: { type: "message_update", assistantMessageEvent: { type: "text_start" } } },
			{
				type: "rpc",
				data: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "after interrupt" } },
			},
		]);

		expect(output).toContain("Turn 1");
		expect(output).toContain("before interrupt");
		expect(output).toContain("Turn 2");
		expect(output).toContain("Input: [URGENT MESSAGE]");
		expect(output).toContain("Turn 3");
		expect(output).toContain("after interrupt");
		expect(output).not.toContain("before interruptafter interrupt");

		const beforeIdx = output.indexOf("before interrupt");
		const interruptIdx = output.indexOf("Input: [URGENT MESSAGE]");
		const afterIdx = output.indexOf("after interrupt");
		expect(beforeIdx).toBeGreaterThanOrEqual(0);
		expect(interruptIdx).toBeGreaterThan(beforeIdx);
		expect(afterIdx).toBeGreaterThan(interruptIdx);
	});

	test("renders wake events as visible log entries", () => {
		const output = render([
			{
				type: "log",
				level: "info",
				message: "IPC: wake",
				data: { type: "wake", source: "ipc" },
			},
		]);

		expect(output).toContain("IPC: wake");
	});
});

describe("OMS custom tool rendering", () => {
	test("renders delete_task_issue with content and args", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-del-1",
					toolName: "delete_task_issue",
					args: { id: "oms-custom-tool-7ac7" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-del-1",
					toolName: "delete_task_issue",
					isError: false,
					result: {
						content: [
							{
								type: "text",
								text: "delete_task_issue: stopped agents for oms-custom-tool-7ac7; deleted issue oms-custom-tool-7ac7",
							},
						],
						details: { id: "oms-custom-tool-7ac7", stopped: true, mode: "delete" },
					},
				},
			},
		]);

		expect(output).toContain("delete_task_issue");
		expect(output).toContain("oms-custom-tool-7ac7");
		expect(output).toContain("stopped agents");
	});

	test("renders broadcast_to_workers with message arg", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-bc-1",
					toolName: "broadcast_to_workers",
					args: { message: "Module changed" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-bc-1",
					toolName: "broadcast_to_workers",
					isError: false,
					result: {
						content: [{ type: "text", text: "OK (broadcast queued)" }],
					},
				},
			},
		]);

		expect(output).toContain("broadcast_to_workers");
		expect(output).toContain("Module changed");
		expect(output).toContain("OK (broadcast queued)");
	});

	test("renders close_task and advance_lifecycle results", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-ct-1",
					toolName: "close_task",
					args: { reason: "Worker completed successfully" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-ct-1",
					toolName: "close_task",
					isError: false,
					result: {
						content: [{ type: "text", text: "close_task completed for task-456" }],
						details: { ok: true },
					},
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-al-1",
					toolName: "advance_lifecycle",
					args: { action: "worker" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-al-1",
					toolName: "advance_lifecycle",
					isError: false,
					result: {
						content: [{ type: "text", text: "advance_lifecycle recorded for task-456: worker" }],
						details: { ok: true },
					},
				},
			},
		]);

		expect(output).toContain("close_task");
		expect(output).toContain("Worker completed successfully");
		expect(output).toContain("close_task completed for task-456");
		expect(output).toContain("advance_lifecycle");
		expect(output).toContain("worker");
		expect(output).toContain("advance_lifecycle recorded");
	});

	test("renders replace_agent with role and taskId args", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-ra-1",
					toolName: "replace_agent",
					args: { role: "finisher", taskId: "task-789" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-ra-1",
					toolName: "replace_agent",
					isError: false,
					result: {
						content: [{ type: "text", text: "OK (replace_agent queued: finisher for task task-789)" }],
					},
				},
			},
		]);

		expect(output).toContain("replace_agent");
		expect(output).toContain("finisher task-789");
		expect(output).toContain("replace_agent queued");
	});

	test("renders complain and revoke_complaint", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-cp-1",
					toolName: "complain",
					args: { reason: "Editing src/foo.ts", files: ["src/foo.ts"] },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-cp-1",
					toolName: "complain",
					isError: false,
					result: {
						content: [{ type: "text", text: "Complaint registered for src/foo.ts" }],
					},
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-rv-1",
					toolName: "revoke_complaint",
					args: { files: ["src/foo.ts", "src/bar.ts"] },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-rv-1",
					toolName: "revoke_complaint",
					isError: false,
					result: {
						content: [{ type: "text", text: "Complaints revoked" }],
					},
				},
			},
		]);

		expect(output).toContain("complain");
		expect(output).toContain("Editing src/foo.ts");
		expect(output).toContain("Complaint registered");
		expect(output).toContain("revoke_complaint");
		expect(output).toContain("src/foo.ts, src/bar.ts");
		expect(output).toContain("Complaints revoked");
	});

	test("renders OMS tools with empty content as ok", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-ia-1",
					toolName: "interrupt_agent",
					args: { taskId: "task-abc" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-ia-1",
					toolName: "interrupt_agent",
					isError: false,
					result: { content: [], details: { ok: true } },
				},
			},
		]);

		expect(output).toContain("interrupt_agent");
		expect(output).toContain("task-abc");
		// With empty content, the OMS preview produces "interrupt_agent: ok" which becomes resultPreview
		expect(output).toContain("interrupt_agent: ok");
	});

	test("renders OMS tool errors with error message", () => {
		const output = render([
			{
				type: "rpc",
				data: {
					type: "tool_execution_start",
					toolCallId: "call-sa-1",
					toolName: "steer_agent",
					args: { taskId: "task-err" },
				},
			},
			{
				type: "rpc",
				data: {
					type: "tool_execution_end",
					toolCallId: "call-sa-1",
					toolName: "steer_agent",
					isError: true,
					result: {
						content: [{ type: "text", text: "steer_agent failed for task task-err" }],
						details: { error: "agent not found" },
					},
				},
			},
		]);

		expect(output).toContain("steer_agent");
		expect(output).toContain("steer_agent failed");
	});
});
