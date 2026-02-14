import { describe, expect, test } from "bun:test";

import { getRenderedRpcLines } from "./rpc-renderer";

function stripAnsi(value: string): string {
	return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function render(events: readonly unknown[]): string {
	const lines = getRenderedRpcLines(events, 160);
	return stripAnsi(lines.join("\n"));
}

describe("rpc renderer tool and wake rendering", () => {
	test("renders tasks tool action and successful result text", () => {
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
						content: [{ type: "text", text: 'tasks list: ok\n[{"id":"task-1"}]' }],
						details: [{ id: "task-1" }],
					},
				},
			},
		]);

		expect(output).toContain("tasks");
		expect(output).toContain("list");
		expect(output).toContain("tasks list: ok");
		expect(output).toContain("task-1");
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

		expect(output).toContain("Created task task-9");
		expect(output).toContain("tasks comment_add: ok (no output)");
		expect(output).toContain("Started task spawning");
		expect(output).toContain("spawned=2");
		expect(output).toContain("(no output)");
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
