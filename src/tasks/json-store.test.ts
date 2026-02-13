import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeJsonTaskStoreDir, JsonTaskStore } from "./store";

type StoreFixture = {
	store: JsonTaskStore;
	storeFilePath: string;
	sessionDir: string;
};

async function withStoreFixture(run: (fixture: StoreFixture) => Promise<void>): Promise<void> {
	const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-json-store-test-"));
	const storeDir = computeJsonTaskStoreDir(sessionDir);
	await fs.mkdir(storeDir, { recursive: true });
	const storeFilePath = path.join(storeDir, "tasks.json");
	const store = new JsonTaskStore({
		cwd: process.cwd(),
		sessionDir,
		actor: "oms-test",
	});

	try {
		await store.ready();
		await run({ store, storeFilePath, sessionDir });
	} finally {
		await fs.rm(sessionDir, { recursive: true, force: true });
	}
}

async function waitForMtimeIncrease(filePath: string, baseline: number, timeoutMs: number): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const stat = await fs.stat(filePath);
		if (stat.mtimeMs > baseline) return true;
		await Bun.sleep(25);
	}
	return false;
}

describe("JsonTaskStore telemetry write-path", () => {
	test("recordAgentEvent defers skip-activity flush to background timer", async () => {
		await withStoreFixture(async ({ store, storeFilePath }) => {
			const task = await store.create("telemetry flush fixture");
			const agentId = await store.createAgent("telemetry-agent");
			await store.setSlot(agentId, "hook", task.id);
			await store.setAgentState(agentId, "working");

			const indexFilePath = path.join(path.dirname(storeFilePath), "_index.json");
			const before = (await fs.stat(indexFilePath)).mtimeMs;
			await store.recordAgentEvent(
				agentId,
				{
					type: "message_end",
					message: {
						role: "assistant",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { total: 0 },
						},
					},
				},
				task.id,
			);

			const immediate = (await fs.stat(indexFilePath)).mtimeMs;
			expect(immediate).toBe(before);

			const changed = await waitForMtimeIncrease(indexFilePath, before, 2_000);
			expect(changed).toBe(true);
		});
	});

	test("recordAgentEvent does not persist raw payload messages", async () => {
		await withStoreFixture(async ({ store, storeFilePath }) => {
			const task = await store.create("telemetry payload-strip fixture");
			const agentId = await store.createAgent("payload-strip-agent");
			await store.setSlot(agentId, "hook", task.id);
			await store.setAgentState(agentId, "working");

			const indexFilePath = path.join(path.dirname(storeFilePath), "_index.json");
			const before = (await fs.stat(indexFilePath)).mtimeMs;
			await store.recordAgentEvent(
				agentId,
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "x".repeat(250_000) }],
					},
				},
				task.id,
			);

			const changed = await waitForMtimeIncrease(indexFilePath, before, 2_000);
			expect(changed).toBe(true);

			const history = await store.readAgentMessages(agentId, 40);
			expect(history).toEqual([]);

			const agentFilePath = path.join(path.dirname(storeFilePath), `${agentId}.json`);
			const rawAgent = await fs.readFile(agentFilePath, "utf8");
			const parsedAgent = JSON.parse(rawAgent) as {
				__agent_log?: { messages?: unknown[] };
			};
			expect(parsedAgent.__agent_log?.messages ?? []).toEqual([]);
		});
	});

	test("load() compacts legacy persisted agent message payloads", async () => {
		await withStoreFixture(async ({ sessionDir, storeFilePath }) => {
			const now = new Date().toISOString();
			const legacyPayload = {
				version: 1,
				nextCommentId: 1,
				issues: {
					"task-1": {
						id: "task-1",
						title: "Legacy task",
						status: "open",
						priority: 0,
						issue_type: "task",
						labels: [],
						assignee: "oms-test",
						created_at: now,
						updated_at: now,
						comments: [],
						depends_on_ids: [],
						dependencies: [],
					},
					"agent-1": {
						id: "agent-1",
						title: "Legacy agent",
						status: "working",
						priority: 0,
						issue_type: "agent",
						labels: ["gt:agent"],
						assignee: "oms-test",
						created_at: now,
						updated_at: now,
						comments: [],
						depends_on_ids: [],
						dependencies: [],
						hook_task: "task-1",
						agent_state: "working",
						last_activity: now,
					},
				},
				activity: [],
				agentLogs: {
					"agent-1": {
						agent_id: "agent-1",
						task_id: "task-1",
						updated_at: now,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: 0,
						},
						messages: [
							{
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: "x".repeat(300_000) }],
								},
							},
						],
					},
				},
			};

			await fs.writeFile(storeFilePath, `${JSON.stringify(legacyPayload, null, 2)}\n`, "utf8");
			const beforeSize = (await fs.stat(storeFilePath)).size;

			const reloaded = new JsonTaskStore({
				cwd: process.cwd(),
				sessionDir,
				actor: "oms-test",
			});
			await reloaded.ready();

			const migratedStorePath = `${storeFilePath}.migrated`;
			const migratedRaw = await fs.readFile(migratedStorePath, "utf8");
			const migrated = JSON.parse(migratedRaw) as {
				agentLogs?: Record<string, { messages?: unknown[] }>;
			};
			expect(migrated.agentLogs?.["agent-1"]).toBeDefined();

			const compactedAgentFilePath = path.join(path.dirname(storeFilePath), "agent-1.json");
			const compactedTaskFilePath = path.join(path.dirname(storeFilePath), "task-1.json");
			const compactedRaw = await fs.readFile(compactedAgentFilePath, "utf8");
			const compactedAgent = JSON.parse(compactedRaw) as {
				__agent_log?: { messages?: unknown[] };
			};
			expect(compactedAgent.__agent_log?.messages ?? []).toEqual([]);

			const afterSize = (await fs.stat(compactedAgentFilePath)).size + (await fs.stat(compactedTaskFilePath)).size;
			expect(afterSize).toBeLessThan(beforeSize / 10);
		});
	});

	test("telemetry backlog does not block createAgent for multiple seconds", async () => {
		await withStoreFixture(async ({ store }) => {
			const task = await store.create("spawn latency fixture");
			const sourceAgentId = await store.createAgent("source-agent");
			await store.setSlot(sourceAgentId, "hook", task.id);
			await store.setAgentState(sourceAgentId, "working");

			const eventPayload = {
				type: "message_end",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
						cost: { total: 0.01 },
					},
				},
			};

			const pending: Array<Promise<unknown>> = [];
			for (let i = 0; i < 120; i += 1) {
				pending.push(store.recordAgentEvent(sourceAgentId, { ...eventPayload, seq: i }, task.id));
			}

			const started = Date.now();
			await store.createAgent("after-backlog");
			const elapsedMs = Date.now() - started;

			expect(elapsedMs).toBeLessThan(1_200);
			await Promise.all(pending);
		});
	});
});
