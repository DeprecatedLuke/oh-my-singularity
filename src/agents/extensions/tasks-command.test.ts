import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import tasksCommandExtension from "./tasks-command";
import type { ExtensionAPI, TypeBuilder, UnknownRecord } from "./types";

type RegisteredCommand = {
	name: string;
	handler: (context: unknown) => Promise<void>;
};

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

async function registerTasksCommand(): Promise<RegisteredCommand> {
	let registered: RegisteredCommand | null = null;
	const api: ExtensionAPI = {
		typebox: { Type: createMockTypebox() },
		registerTool: () => {
			// noop
		},
		registerCommand: (name, options) => {
			registered = {
				name,
				handler: options.handler,
			};
		},
		on: () => {
			// noop
		},
	};

	await tasksCommandExtension(api);
	if (!registered) throw new Error("tasks command was not registered");
	return registered;
}

async function startMockIpcServer(onRequest: (payload: UnknownRecord) => unknown | Promise<unknown>): Promise<{
	sockPath: string;
	requests: UnknownRecord[];
	close: () => Promise<void>;
}> {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oms-tasks-command-"));
	const sockPath = path.join(tempDir, "ipc.sock");
	const requests: UnknownRecord[] = [];

	const server = net.createServer(socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex < 0) return;

			const line = buffer.slice(0, newlineIndex).trim();
			let payload: UnknownRecord = {};
			if (line) {
				const parsed = JSON.parse(line);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					payload = parsed as UnknownRecord;
				}
			}
			requests.push(payload);

			void Promise.resolve(onRequest(payload)).then(response => {
				if (response === undefined) {
					socket.end("ok\n");
					return;
				}
				socket.end(`${JSON.stringify(response)}\n`);
			});
		});
	});

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(sockPath, () => resolve());
	await promise;

	return {
		sockPath,
		requests,
		close: async () => {
			const deferred = Promise.withResolvers<void>();
			server.close(() => deferred.resolve());
			await deferred.promise;
			fs.rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function runCommand(handler: (context: unknown) => Promise<void>, args: string[]): Promise<string> {
	const output: string[] = [];
	await handler({
		args,
		reply: (value: unknown) => {
			if (typeof value === "string") {
				output.push(value);
				return;
			}
			if (value && typeof value === "object" && !Array.isArray(value)) {
				const text = (value as { text?: unknown }).text;
				if (typeof text === "string") {
					output.push(text);
					return;
				}
			}
			output.push(String(value));
		},
	});
	return output.join("\n");
}

async function withSocketEnv(sockPath: string, run: () => Promise<void>): Promise<void> {
	const prevSock = process.env.OMS_SINGULARITY_SOCK;
	const prevActor = process.env.TASKS_ACTOR;
	process.env.OMS_SINGULARITY_SOCK = sockPath;
	process.env.TASKS_ACTOR = "oms-test";

	try {
		await run();
	} finally {
		if (prevSock == null) {
			delete process.env.OMS_SINGULARITY_SOCK;
		} else {
			process.env.OMS_SINGULARITY_SOCK = prevSock;
		}
		if (prevActor == null) {
			delete process.env.TASKS_ACTOR;
		} else {
			process.env.TASKS_ACTOR = prevActor;
		}
	}
}

describe("tasks slash command extension", () => {
	test("registers command and prints help when called without args", async () => {
		const command = await registerTasksCommand();
		expect(command.name).toBe("tasks");

		const output = await runCommand(command.handler, []);
		expect(output).toContain("/tasks list");
		expect(output).toContain("/tasks delete <id>");
	});

	test("list subcommand calls tasks_request list and renders open tasks", async () => {
		const command = await registerTasksCommand();
		const server = await startMockIpcServer(payload => {
			if (payload.type === "tasks_request" && payload.action === "list") {
				return {
					ok: true,
					data: [
						{ id: "task-open", title: "Keep this", status: "open", priority: 2 },
						{ id: "task-closed", title: "Hide this", status: "closed", priority: 1 },
					],
				};
			}
			return { ok: false, error: "unexpected request" };
		});

		try {
			await withSocketEnv(server.sockPath, async () => {
				const output = await runCommand(command.handler, ["list"]);
				expect(output).toContain("Open tasks (1):");
				expect(output).toContain("task-open [open] p2 Keep this");
				expect(output).not.toContain("task-closed");
			});

			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.type).toBe("tasks_request");
			expect(server.requests[0]?.action).toBe("list");
		} finally {
			await server.close();
		}
	});

	test("show subcommand loads issue details plus comments", async () => {
		const command = await registerTasksCommand();
		const server = await startMockIpcServer(payload => {
			if (payload.type === "tasks_request" && payload.action === "show") {
				return {
					ok: true,
					data: {
						id: "task-42",
						title: "Investigate incident",
						status: "in_progress",
						priority: 0,
						issue_type: "task",
						description: "Line one\nLine two",
						acceptance_criteria: "Must be reproducible",
					},
				};
			}
			if (payload.type === "tasks_request" && payload.action === "comments") {
				return {
					ok: true,
					data: [{ author: "dev", created_at: "2026-02-13T10:00:00.000Z", text: "Checked logs" }],
				};
			}
			return { ok: false, error: "unexpected request" };
		});

		try {
			await withSocketEnv(server.sockPath, async () => {
				const output = await runCommand(command.handler, ["show", "task-42"]);
				expect(output).toContain("task-42: Investigate incident");
				expect(output).toContain("Description:");
				expect(output).toContain("Line one");
				expect(output).toContain("Comments (1):");
				expect(output).toContain("Checked logs");
			});

			expect(server.requests).toHaveLength(2);
			expect(server.requests[0]?.action).toBe("show");
			expect(server.requests[1]?.action).toBe("comments");
		} finally {
			await server.close();
		}
	});

	test("start subcommand triggers start_tasks IPC", async () => {
		const command = await registerTasksCommand();
		const server = await startMockIpcServer(payload => {
			if (payload.type === "start_tasks") {
				return { ok: true, spawned: 2, taskIds: ["task-a", "task-b"] };
			}
			return { ok: false, error: "unexpected request" };
		});

		try {
			await withSocketEnv(server.sockPath, async () => {
				const output = await runCommand(command.handler, ["start"]);
				expect(output).toContain("spawned=2");
				expect(output).toContain("task-a");
				expect(output).toContain("task-b");
			});

			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.type).toBe("start_tasks");
		} finally {
			await server.close();
		}
	});

	test("stop subcommand reports when no active agents exist", async () => {
		const command = await registerTasksCommand();
		const server = await startMockIpcServer(payload => {
			if (payload.type === "list_task_agents") {
				return {
					ok: true,
					taskId: "task-9",
					agents: [{ id: "worker:task-9", state: "done" }],
				};
			}
			if (payload.type === "interrupt_agent") {
				return { ok: false, error: "interrupt should not be called when no active agents exist" };
			}
			return { ok: false, error: "unexpected request" };
		});

		try {
			await withSocketEnv(server.sockPath, async () => {
				const output = await runCommand(command.handler, ["stop", "task-9"]);
				expect(output).toContain("No active agents found for task task-9.");
			});

			expect(server.requests).toHaveLength(1);
			expect(server.requests[0]?.type).toBe("list_task_agents");
		} finally {
			await server.close();
		}
	});

	test("delete subcommand stops agents before deleting task", async () => {
		const command = await registerTasksCommand();
		const server = await startMockIpcServer(payload => {
			if (payload.type === "stop_agents_for_task") {
				return { ok: true };
			}
			if (payload.type === "tasks_request" && payload.action === "delete") {
				return { ok: true, data: { id: "task-5" } };
			}
			return { ok: false, error: "unexpected request" };
		});

		try {
			await withSocketEnv(server.sockPath, async () => {
				const output = await runCommand(command.handler, ["delete", "task-5"]);
				expect(output).toContain("Deleted task task-5.");
			});

			expect(server.requests).toHaveLength(2);
			expect(server.requests[0]?.type).toBe("stop_agents_for_task");
			expect(server.requests[1]?.type).toBe("tasks_request");
			expect(server.requests[1]?.action).toBe("delete");
		} finally {
			await server.close();
		}
	});
});
