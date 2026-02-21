import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import deleteTaskIssue from "./delete-task-issue";
import type { ToolDefinition, TypeBuilder, UnknownRecord } from "./types";

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

async function startMockIpcServer(
	onRequest: (payload: UnknownRecord) => unknown | Promise<unknown>,
): Promise<{ sockPath: string; close: () => Promise<void> }> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oms-delete-task-issue-"));
	const sockPath = path.join(tempDir, "ipc.sock");

	const server = net.createServer(socket => {
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

			void Promise.resolve(onRequest(payload as UnknownRecord)).then(response => {
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

describe("delete_task_issue extension", () => {
	test("returns error when issue does not exist", async () => {
		const observedPayloads: UnknownRecord[] = [];
		const server = await startMockIpcServer(payload => {
			observedPayloads.push(payload);
			if (payload.action === "show") {
				return { ok: false, error: "issue not found" };
			}
			return { ok: false, error: "unexpected action" };
		});

		const previousSock = process.env.OMS_SINGULARITY_SOCK;
		const previousActor = process.env.TASKS_ACTOR;
		process.env.OMS_SINGULARITY_SOCK = server.sockPath;
		process.env.TASKS_ACTOR = "oms-test";
		let registeredTool: ToolDefinition | null = null;
		try {
			await deleteTaskIssue({
				typebox: { Type: createMockTypebox() },
				registerTool: tool => {
					registeredTool = tool;
				},
				on: () => {
					// noop
				},
			});

			const tool = registeredTool as ToolDefinition | null;
			if (!tool) throw new Error("delete_task_issue tool was not registered");
			await expect(tool.execute("call_1", { id: "task-missing" })).rejects.toThrow(
				"delete_task_issue: issue task-missing does not exist",
			);
			expect(observedPayloads).toHaveLength(1);
			expect(observedPayloads[0]).toEqual({
				type: "tasks_request",
				action: "show",
				params: { id: "task-missing" },
				actor: "oms-test",
				ts: expect.any(Number),
			});
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

	test("returns success message when show, close, and delete succeed", async () => {
		const observedPayloads: UnknownRecord[] = [];
		const server = await startMockIpcServer(payload => {
			observedPayloads.push(payload);
			if (payload.action === "show") {
				return {
					ok: true,
					data: {
						id: "task-existing",
						title: "Issue task-existing",
						status: "open",
						issue_type: "task",
						priority: 2,
					},
				};
			}
			if (payload.action === "close") {
				return { ok: true, data: { id: "task-existing", status: "closed" } };
			}
			if (payload.action === "stop_agents_for_task") {
				return { ok: true, data: { stopped: true } };
			}
			if (payload.action === "delete") {
				return { ok: true, data: { id: "task-existing" } };
			}
			return { ok: false, error: `unexpected action ${String(payload.action)}` };
		});

		const previousSock = process.env.OMS_SINGULARITY_SOCK;
		const previousActor = process.env.TASKS_ACTOR;
		process.env.OMS_SINGULARITY_SOCK = server.sockPath;
		process.env.TASKS_ACTOR = "oms-test";
		let registeredTool: ToolDefinition | null = null;
		try {
			await deleteTaskIssue({
				typebox: { Type: createMockTypebox() },
				registerTool: tool => {
					registeredTool = tool;
				},
				on: () => {
					// noop
				},
			});

			const tool = registeredTool as ToolDefinition | null;
			if (!tool) throw new Error("delete_task_issue tool was not registered");
			const result = (await tool.execute("call_2", { id: "task-existing" })) as {
				content?: Array<{ type: string; text: string }>;
				details?: unknown;
			};

			expect(result.content?.[0]?.text).toBe(
				"delete_task_issue: stopped agents for task-existing; deleted issue task-existing",
			);
			expect(result.details).toEqual({
				id: "task-existing",
				stopped: true,
				mode: "delete",
				result: { id: "task-existing" },
			});
			expect(observedPayloads.map(item => item.action ?? item.type)).toEqual([
				"show",
				"close",
				"stop_agents_for_task",
				"delete",
			]);
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
});
