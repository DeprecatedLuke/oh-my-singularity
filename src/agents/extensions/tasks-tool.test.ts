import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { makeTasksExtension } from "./tasks-tool";
import type { ToolDefinition, ToolTheme, TypeBuilder } from "./types";

type RegisteredTool = ToolDefinition;

function createMockTypebox(): TypeBuilder {
	return {
		Object: (shape: Record<string, unknown>) => shape,
		String: () => ({}),
		Optional: <T>(value: T) => value,
		Union: (_schemas: unknown[]) => ({}),
		Literal: (_value: string | number | boolean) => ({}),
		Number: () => ({}),
		Boolean: () => ({}),
		Array: (_itemSchema: unknown) => [],
	};
}

const theme: ToolTheme = {
	fg: (_scope: string, text: string) => text,
	styledSymbol: (_name: string, _color: string) => "●",
	sep: { dot: "·" },
	spinnerFrames: ["⠋", "⠙", "⠹"],
};

async function startMockIpcServer(onRequest: (payload: unknown) => unknown | Promise<unknown>): Promise<{
	sockPath: string;
	close: () => Promise<void>;
}> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oms-tasks-tool-"));
	const sockPath = path.join(tempDir, "ipc.sock");

	const server = net.createServer({ allowHalfOpen: true }, socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex < 0) return;

			const line = buffer.slice(0, newlineIndex).trim();
			let payload: unknown = line;
			if (line) {
				payload = JSON.parse(line);
			}

			void Promise.resolve(onRequest(payload)).then(response => {
				socket.end(`${JSON.stringify(response)}\n`);
			});
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(sockPath, () => resolve());
	});

	return {
		sockPath,
		close: async () => {
			await new Promise<void>(resolve => server.close(() => resolve()));
			fs.rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function registerTasksTool(opts: { agentType: string; allowedActions: string[] }): Promise<RegisteredTool> {
	let registeredTool: RegisteredTool | null = null;
	const extension = makeTasksExtension(opts);
	await extension({
		typebox: { Type: createMockTypebox() },
		registerTool: (tool: RegisteredTool) => {
			registeredTool = tool;
		},
		on: () => {
			// noop
		},
	});
	const tool = registeredTool as RegisteredTool | null;
	if (!tool) throw new Error("tasks tool was not registered");
	return tool;
}

describe("tasks tool extension", () => {
	test("list action returns payload instead of no-output when socket request is fire-and-wait", async () => {
		let observedPayload: Record<string, unknown> | null = null;
		const server = await startMockIpcServer(payload => {
			observedPayload = payload as Record<string, unknown>;
			return {
				ok: true,
				data: [
					{
						id: "task-1",
						title: "Sample task",
						status: "open",
						issue_type: "task",
					},
				],
			};
		});

		const previousSock = process.env.OMS_SINGULARITY_SOCK;
		const previousActor = process.env.TASKS_ACTOR;
		process.env.OMS_SINGULARITY_SOCK = server.sockPath;
		process.env.TASKS_ACTOR = "oms-test";

		try {
			let registeredTool: RegisteredTool | null = null;
			const extension = makeTasksExtension({ agentType: "worker", allowedActions: ["list"] });
			await extension({
				typebox: { Type: createMockTypebox() },
				registerTool: (tool: RegisteredTool) => {
					registeredTool = tool;
				},
				on: () => {
					// noop
				},
			});

			const tool = registeredTool as RegisteredTool | null;
			if (!tool) throw new Error("tasks tool was not registered");
			const result = (await tool.execute("call_1", { action: "list" })) as {
				content?: Array<{ type: string; text: string }>;
				details?: unknown;
			};

			const payload = observedPayload as Record<string, unknown> | null;
			if (!payload) throw new Error("mock IPC server did not receive request payload");
			expect(payload.type).toBe("tasks_request");
			expect(payload.action).toBe("list");
			expect(result.content?.[0]?.text).toContain("tasks list: ok");
			expect(result.content?.[0]?.text).toContain('"task-1"');
			expect(result.content?.[0]?.text).not.toContain("(no output)");
			expect(Array.isArray(result.details)).toBe(true);
		} finally {
			if (previousSock == null) {
				delete process.env.OMS_SINGULARITY_SOCK;
			} else {
				process.env.OMS_SINGULARITY_SOCK = previousSock;
			}
			if (previousActor == null) {
				delete process.env.TASKS_ACTOR;
			} else {
				process.env.TASKS_ACTOR = previousActor;
			}
			await server.close();
		}
	});

	test("ipc errors are prefixed once", async () => {
		let observedPayload: Record<string, unknown> | null = null;
		const server = await startMockIpcServer(payload => {
			observedPayload = payload as Record<string, unknown>;
			return {
				ok: false,
				error: "Issue not found: does-not-exist-999",
			};
		});

		const previousSock = process.env.OMS_SINGULARITY_SOCK;
		const previousActor = process.env.TASKS_ACTOR;
		process.env.OMS_SINGULARITY_SOCK = server.sockPath;
		process.env.TASKS_ACTOR = "oms-test";

		try {
			let registeredTool: RegisteredTool | null = null;
			const extension = makeTasksExtension({ agentType: "agent", allowedActions: ["update"] });
			await extension({
				typebox: { Type: createMockTypebox() },
				registerTool: (tool: RegisteredTool) => {
					registeredTool = tool;
				},
				on: () => {
					// noop
				},
			});

			const tool = registeredTool as RegisteredTool | null;
			if (!tool) throw new Error("tasks tool was not registered");

			let thrown: unknown = null;
			try {
				await tool.execute("call_2", {
					action: "update",
					id: "does-not-exist-999",
				});
			} catch (err) {
				thrown = err;
			}

			if (!(thrown instanceof Error)) throw new Error("expected execute to throw Error");
			expect(thrown.message).toBe("tasks: Issue not found: does-not-exist-999");
			expect(thrown.message).not.toContain("tasks: tasks:");

			const payload = observedPayload as Record<string, unknown> | null;
			if (!payload) throw new Error("mock IPC server did not receive request payload");
			expect(payload.type).toBe("tasks_request");
			expect(payload.action).toBe("update");
		} finally {
			if (previousSock == null) {
				delete process.env.OMS_SINGULARITY_SOCK;
			} else {
				process.env.OMS_SINGULARITY_SOCK = previousSock;
			}
			if (previousActor == null) {
				delete process.env.TASKS_ACTOR;
			} else {
				process.env.TASKS_ACTOR = previousActor;
			}
			await server.close();
		}
	});

	test("renderResult includes scope in create card output", async () => {
		const tool = await registerTasksTool({ agentType: "worker", allowedActions: ["create"] });
		if (!tool.renderResult) throw new Error("tasks tool renderResult was not registered");

		const lines = tool
			.renderResult(
				{
					content: [{ type: "text", text: "tasks create: ok" }],
					details: [
						{
							id: "task-10",
							title: "Scoped task",
							status: "open",
							issue_type: "task",
							priority: 1,
							scope: "medium",
						},
					],
				},
				{ expanded: false, isPartial: false },
				theme,
				{ action: "create" },
			)
			.render(160);

		expect(lines.join("\n")).toContain("S:medium");
	});

	test("renderResult includes scope in list rows", async () => {
		const tool = await registerTasksTool({ agentType: "worker", allowedActions: ["list"] });
		if (!tool.renderResult) throw new Error("tasks tool renderResult was not registered");

		const lines = tool
			.renderResult(
				{
					content: [{ type: "text", text: "tasks list: ok" }],
					details: [
						{
							id: "task-11",
							title: "List scoped task",
							status: "open",
							issue_type: "task",
							priority: 2,
							scope: "small",
						},
					],
				},
				{ expanded: false, isPartial: false },
				theme,
				{ action: "list" },
			)
			.render(160);

		expect(lines.join("\n")).toContain("S:small");
	});
});
