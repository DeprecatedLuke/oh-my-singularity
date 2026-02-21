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

	describe("advance_lifecycle", () => {
		test("parses valid advance_lifecycle with all fields", () => {
			const message = expectParseOk({
				type: "advance_lifecycle",
				agentType: "worker",
				taskId: "task-1",
				action: "advance",
				target: "finisher",
				message: "implementation done",
				reason: "all tests pass",
				agentId: "agent-1",
			});
			expect(message).toEqual({
				type: "advance_lifecycle",
				agentType: "worker",
				taskId: "task-1",
				action: "advance",
				target: "finisher",
				message: "implementation done",
				reason: "all tests pass",
				agentId: "agent-1",
			});
		});

		test("parses close action (no target required)", () => {
			const message = expectParseOk({
				type: "advance_lifecycle",
				agentType: "speedy",
				taskId: "task-2",
				action: "close",
				message: "tiny fix done",
				reason: "completed",
				agentId: "fast-1",
			});
			expect(message).toEqual({
				type: "advance_lifecycle",
				agentType: "speedy",
				taskId: "task-2",
				action: "close",
				target: "",
				message: "tiny fix done",
				reason: "completed",
				agentId: "fast-1",
			});
		});

		test("parses block action", () => {
			const message = expectParseOk({
				type: "advance_lifecycle",
				agentType: "issuer",
				taskId: "task-3",
				action: "block",
				message: "needs clarification",
				reason: "unclear requirements",
				agentId: "issuer-1",
			});
			expect(message).toEqual({
				type: "advance_lifecycle",
				agentType: "issuer",
				taskId: "task-3",
				action: "block",
				target: "",
				message: "needs clarification",
				reason: "unclear requirements",
				agentId: "issuer-1",
			});
		});

		test("rejects invalid action", () => {
			expectParseError(
				{
					type: "advance_lifecycle",
					agentType: "worker",
					taskId: "task-1",
					action: "promote",
					message: "go",
					reason: "nope",
					agentId: "agent-1",
				},
				/"action" must be one of close, block, advance/,
			);
		});

		test("requires target when action is advance", () => {
			expectParseError(
				{
					type: "advance_lifecycle",
					agentType: "worker",
					taskId: "task-1",
					action: "advance",
					target: "",
					message: "done",
					reason: "finished",
					agentId: "agent-1",
				},
				/"target" is required when action is "advance"/,
			);
		});

		test("validates target against agent type's allowed targets", () => {
			// worker can advance to finisher, not issuer
			expectParseError(
				{
					type: "advance_lifecycle",
					agentType: "worker",
					taskId: "task-1",
					action: "advance",
					target: "issuer",
					message: "done",
					reason: "finished",
					agentId: "agent-1",
				},
				/target "issuer" is not a valid advance target for agent type "worker"/,
			);
			// finisher can advance to worker or issuer, not finisher
			expectParseError(
				{
					type: "advance_lifecycle",
					agentType: "finisher",
					taskId: "task-1",
					action: "advance",
					target: "finisher",
					message: "retry",
					reason: "loop",
					agentId: "fin-1",
				},
				/target "finisher" is not a valid advance target for agent type "finisher"/,
			);
		});

		test("rejects non-string fields", () => {
			expectParseError({ type: "advance_lifecycle", agentType: 1 }, /"agentType" must be a string/);
			expectParseError(
				{ type: "advance_lifecycle", agentType: "worker", taskId: "t-1", action: "block", reason: 1 },
				/"reason" must be a string/,
			);
			expectParseError(
				{ type: "advance_lifecycle", agentType: "worker", taskId: "t-1", action: "block", agentId: false },
				/"agentId" must be a string/,
			);
		});
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
		test("trims agent and accepts empty agent", () => {
			expect(expectParseOk({ type: "replace_agent", agent: " worker ", taskId: "task-1", context: "ctx" })).toEqual({
				type: "replace_agent",
				agent: "worker",
				taskId: "task-1",
				context: "ctx",
			});
			expect(expectParseOk({ type: "replace_agent", agent: "  ", taskId: "task-1", context: "ctx" })).toEqual({
				type: "replace_agent",
				agent: "",
				taskId: "task-1",
				context: "ctx",
			});
		});

		test("rejects invalid agent values and types", () => {
			expectParseError(
				{ type: "replace_agent", agent: "manager", taskId: "task-1", context: "ctx" },
				/"agent" must be one of/,
			);
			expectParseError(
				{ type: "replace_agent", agent: 3, taskId: "task-1", context: "ctx" },
				/"agent" must be a string/,
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
