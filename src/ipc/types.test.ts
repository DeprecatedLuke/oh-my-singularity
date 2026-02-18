import { describe, expect, test } from "bun:test";

import { LIMIT_MESSAGE_HISTORY_DEFAULT, TIMEOUT_AGENT_WAIT_MS, TIMEOUT_MIN_MS } from "../config/constants";
import { parseIPCMessage } from "./types";

function expectParseOk(payload: unknown) {
	const result = parseIPCMessage(payload);
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error);
	return result.message;
}

function expectParseError(payload: unknown, pattern: RegExp) {
	const result = parseIPCMessage(payload);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected parse error");
	expect(result.error).toMatch(pattern);
}

describe("parseIPCMessage", () => {
	test("defaults to wake when payload is nullish or not a record", () => {
		expect(expectParseOk(null)).toEqual({ type: "wake" });
		expect(expectParseOk(undefined)).toEqual({ type: "wake" });
		expect(expectParseOk("x")).toEqual({ type: "wake" });
	});

	test("defaults to wake when type is missing or non-string", () => {
		expect(expectParseOk({ foo: 1 })).toEqual({ foo: 1, type: "wake" });
		expect(expectParseOk({ type: 42, foo: "bar" })).toEqual({ type: "wake", foo: "bar" });
	});

	test("parses start_tasks count", () => {
		expect(expectParseOk({ type: "start_tasks", count: 3.7 })).toEqual({
			type: "start_tasks",
			count: 3,
		});
		expect(expectParseOk({ type: "start_tasks" })).toEqual({
			type: "start_tasks",
			count: 0,
		});
	});

	test("rejects invalid start_tasks count", () => {
		expectParseError({ type: "start_tasks", count: "1" }, /"count" must be a finite number/);
	});

	test("returns an unknown-type error with supported list", () => {
		expectParseError(
			{ type: "not-real" },
			/^Unknown IPC message type "not-real"\. Expected one of: .*read_message_history\.$/,
		);
	});

	describe("tasks_request", () => {
		test("parses valid message with optional params/defaultTaskId", () => {
			const message = expectParseOk({
				type: "tasks_request",
				action: "list",
				params: { status: "open" },
				defaultTaskId: "task-1",
			});
			expect(message).toEqual({
				type: "tasks_request",
				action: "list",
				params: { status: "open" },
				defaultTaskId: "task-1",
			});
		});

		test("defaults missing action to empty string", () => {
			const message = expectParseOk({ type: "tasks_request" });
			expect(message).toEqual({ type: "tasks_request", action: "", params: undefined, defaultTaskId: undefined });
		});

		test("rejects non-string action and non-object params", () => {
			expectParseError({ type: "tasks_request", action: 7 }, /"action" must be a string/);
			expectParseError({ type: "tasks_request", action: "list", params: [] }, /"params" must be an object/);
		});
	});

	describe("issuer_advance_lifecycle", () => {
		test("parses required lifecycle fields", () => {
			const message = expectParseOk({
				type: "issuer_advance_lifecycle",
				taskId: "task-1",
				action: "promote",
				message: "ready",
				reason: "approved",
				agentId: "agent-1",
			});
			expect(message).toEqual({
				type: "issuer_advance_lifecycle",
				taskId: "task-1",
				action: "promote",
				message: "ready",
				reason: "approved",
				agentId: "agent-1",
			});
		});

		test("rejects wrong field types", () => {
			expectParseError({ type: "issuer_advance_lifecycle", reason: 1 }, /"reason" must be a string/);
		});
	});

	describe("finisher_advance_lifecycle", () => {
		test("parses required lifecycle fields and validates action values", () => {
			const message = expectParseOk({
				type: "finisher_advance_lifecycle",
				taskId: "task-1",
				action: "worker",
				message: "resume implementation",
				reason: "needs code changes",
				agentId: "fin-1",
			});
			expect(message).toEqual({
				type: "finisher_advance_lifecycle",
				taskId: "task-1",
				action: "worker",
				message: "resume implementation",
				reason: "needs code changes",
				agentId: "fin-1",
			});
		});

		test("rejects unsupported action", () => {
			expectParseError(
				{
					type: "finisher_advance_lifecycle",
					taskId: "task-1",
					action: "start",
					message: "go",
					reason: "nope",
					agentId: "fin-1",
				},
				/"action" must be one of worker, issuer, defer/,
			);
		});
	});

	test("parses finisher_close_task and rejects non-string reason", () => {
		expect(
			expectParseOk({ type: "finisher_close_task", taskId: "task-1", reason: "done", agentId: "fin-1" }),
		).toEqual({
			type: "finisher_close_task",
			taskId: "task-1",
			reason: "done",
			agentId: "fin-1",
		});
		expectParseError({ type: "finisher_close_task", reason: false }, /"reason" must be a string/);
	});

	test("parses broadcast, interrupt_agent, steer_agent", () => {
		expect(expectParseOk({ type: "broadcast", message: "heads up" })).toEqual({
			type: "broadcast",
			message: "heads up",
		});
		expect(expectParseOk({ type: "interrupt_agent", taskId: "task-1", message: "stop" })).toEqual({
			type: "interrupt_agent",
			taskId: "task-1",
			message: "stop",
		});
		expect(expectParseOk({ type: "steer_agent", taskId: "task-2", message: "continue" })).toEqual({
			type: "steer_agent",
			taskId: "task-2",
			message: "continue",
		});
		expectParseError({ type: "broadcast", message: { bad: true } }, /"message" must be a string/);
	});

	describe("replace_agent", () => {
		test("trims role and accepts empty role", () => {
			expect(expectParseOk({ type: "replace_agent", role: " worker ", taskId: "task-1", context: "ctx" })).toEqual({
				type: "replace_agent",
				role: "worker",
				taskId: "task-1",
				context: "ctx",
			});
			expect(expectParseOk({ type: "replace_agent", role: "  ", taskId: "task-1", context: "ctx" })).toEqual({
				type: "replace_agent",
				role: "",
				taskId: "task-1",
				context: "ctx",
			});
		});

		test("rejects invalid role values and types", () => {
			expectParseError(
				{ type: "replace_agent", role: "manager", taskId: "task-1", context: "ctx" },
				/"role" must be one of finisher, issuer, worker/,
			);
			expectParseError(
				{ type: "replace_agent", role: 3, taskId: "task-1", context: "ctx" },
				/"role" must be a string/,
			);
		});
	});

	describe("stop_agents_for_task", () => {
		test("defaults booleans to false", () => {
			expect(expectParseOk({ type: "stop_agents_for_task", taskId: "task-1" })).toEqual({
				type: "stop_agents_for_task",
				taskId: "task-1",
				includeFinisher: false,
				waitForCompletion: false,
			});
		});

		test("rejects non-boolean flags", () => {
			expectParseError(
				{ type: "stop_agents_for_task", taskId: "task-1", includeFinisher: "yes" },
				/"includeFinisher" must be a boolean/,
			);
		});
	});

	describe("complain + revoke_complaint", () => {
		test("normalizes files and optional fields", () => {
			expect(
				expectParseOk({
					type: "complain",
					files: [" a.ts ", "", 1, "b.ts"],
					reason: "blocked",
					complainantAgentId: "agent-1",
					complainantTaskId: "task-1",
				}),
			).toEqual({
				type: "complain",
				files: ["a.ts", "b.ts"],
				reason: "blocked",
				complainantAgentId: "agent-1",
				complainantTaskId: "task-1",
			});

			expect(expectParseOk({ type: "revoke_complaint" })).toEqual({
				type: "revoke_complaint",
				files: undefined,
				complainantAgentId: undefined,
				complainantTaskId: undefined,
			});
		});

		test("rejects invalid files and reason types", () => {
			expectParseError({ type: "complain", files: "x", reason: "r" }, /"files" must be an array of strings/);
			expectParseError({ type: "complain", files: [], reason: 1 }, /"reason" must be a string/);
			expectParseError({ type: "revoke_complaint", files: {} }, /"files" must be an array of strings/);
		});
	});

	describe("wait_for_agent", () => {
		test("trims agent id and applies timeout defaults/normalization", () => {
			expect(expectParseOk({ type: "wait_for_agent", agentId: "  agent-1  " })).toEqual({
				type: "wait_for_agent",
				agentId: "agent-1",
				timeoutMs: TIMEOUT_AGENT_WAIT_MS,
			});
			expect(expectParseOk({ type: "wait_for_agent", agentId: "agent-1", timeoutMs: 999.9 })).toEqual({
				type: "wait_for_agent",
				agentId: "agent-1",
				timeoutMs: TIMEOUT_MIN_MS,
			});
		});

		test("rejects invalid timeout type", () => {
			expectParseError(
				{ type: "wait_for_agent", agentId: "agent-1", timeoutMs: "1s" },
				/"timeoutMs" must be a finite number/,
			);
		});
	});

	test("parses list_active_agents and list_task_agents", () => {
		expect(expectParseOk({ type: "list_active_agents" })).toEqual({ type: "list_active_agents" });
		expect(expectParseOk({ type: "list_task_agents", taskId: "  task-7  " })).toEqual({
			type: "list_task_agents",
			taskId: "task-7",
		});
		expectParseError({ type: "list_task_agents", taskId: 9 }, /"taskId" must be a string/);
	});

	describe("read_message_history", () => {
		test("parses with default and custom limit", () => {
			expect(expectParseOk({ type: "read_message_history", agentId: " a-1 ", taskId: " task-1 " })).toEqual({
				type: "read_message_history",
				agentId: "a-1",
				limit: LIMIT_MESSAGE_HISTORY_DEFAULT,
				taskId: "task-1",
			});
			expect(expectParseOk({ type: "read_message_history", agentId: "a-1", taskId: "task-1", limit: 12.5 })).toEqual(
				{
					type: "read_message_history",
					agentId: "a-1",
					limit: 12.5,
					taskId: "task-1",
				},
			);
		});

		test("rejects invalid numeric limit", () => {
			expectParseError(
				{ type: "read_message_history", agentId: "a-1", taskId: "task-1", limit: Number.NaN },
				/"limit" must be a finite number/,
			);
		});
	});
});
