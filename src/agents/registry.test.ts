import { describe, expect, test } from "bun:test";

import type { TaskStoreClient } from "../tasks/client";
import { AgentRegistry } from "./registry";
import { createEmptyAgentUsage } from "./types";

describe("AgentRegistry readMessageHistory persistence fallback", () => {
	test("loads persisted history when only tasks-agent id is available", async () => {
		const persistedMessages = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call-1",
						name: "tasks",
						input: { action: "list" },
					},
				],
			},
			{
				role: "tool",
				tool_use_id: "call-1",
				content: [{ type: "text", text: "ok" }],
				is_error: false,
			},
		];

		const tasksClient = {
			readAgentMessages: async (agentId: string) => (agentId === "agent-123" ? persistedMessages : []),
		} as unknown as TaskStoreClient;

		const registry = new AgentRegistry({ tasksClient });
		const history = await registry.readMessageHistory("worker:task-1:agent-123", 50);

		expect(history.agent).toBeNull();
		expect(history.messages).toHaveLength(2);
		expect(history.toolCalls).toHaveLength(1);
		expect(history.toolCalls[0]?.name).toBe("tasks");
	});

	test("resolves registry agent by tasks-agent id", async () => {
		const tasksClient = {
			readAgentMessages: async () => [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
		} as unknown as TaskStoreClient;

		const registry = new AgentRegistry({ tasksClient });
		registry.register({
			id: "worker:task-1:agent-xyz",
			role: "worker",
			taskId: "task-1",
			tasksAgentId: "agent-xyz",
			status: "done",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt: 100,
			lastActivity: 200,
		});

		const history = await registry.readMessageHistory("agent-xyz", 20);
		expect(history.agent?.id).toBe("worker:task-1:agent-xyz");
		expect(history.messages).toHaveLength(1);
	});
});
