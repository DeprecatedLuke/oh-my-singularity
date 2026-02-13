import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeJsonTaskStoreDir, JsonTaskStore } from "./base";

type StoreFixture = {
	store: JsonTaskStore;
	sessionDir: string;
	storeFilePath: string;
};

async function withStoreFixture(run: (fixture: StoreFixture) => Promise<void>): Promise<void> {
	const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-store-base-test-"));
	const storeFilePath = path.join(computeJsonTaskStoreDir(sessionDir), "tasks.json");
	const store = new JsonTaskStore({
		cwd: process.cwd(),
		sessionDir,
		actor: "oms-test",
	});

	try {
		await store.ready();
		await run({ store, sessionDir, storeFilePath });
	} finally {
		await fs.rm(sessionDir, { recursive: true, force: true });
	}
}

describe("JsonTaskStore CRUD", () => {
	test("create/show/update/close/delete lifecycle", async () => {
		await withStoreFixture(async ({ store }) => {
			const created = await store.create("Store CRUD fixture", "desc", 2, { labels: ["l1"] });
			expect(created.title).toBe("Store CRUD fixture");
			expect(created.status).toBe("open");

			const shown = await store.show(created.id);
			expect(shown.id).toBe(created.id);
			expect(shown.description).toBe("desc");

			const updated = (await store.update(created.id, {
				status: "in_progress",
				assignee: "oms-worker",
				priority: 1,
			})) as { status: string; assignee: string; priority: number };
			expect(updated.status).toBe("in_progress");
			expect(updated.assignee).toBe("oms-worker");
			expect(updated.priority).toBe(1);

			const closed = (await store.close(created.id, "done")) as { status: string };
			expect(closed.status).toBe("closed");

			await store.delete(created.id);
			expect(store.show(created.id)).rejects.toThrow(/not found/i);
		});
	});

	test("list respects status/type/includeClosed filters", async () => {
		await withStoreFixture(async ({ store }) => {
			const openTask = await store.create("Open Task");
			const closedTask = await store.create("Closed Task");
			await store.close(closedTask.id, "done");
			await store.create("A bug", null, 3, { type: "bug" });

			const defaultList = await store.list();
			expect(defaultList.some(issue => issue.id === closedTask.id)).toBe(false);
			expect(defaultList.some(issue => issue.id === openTask.id)).toBe(true);

			const includeClosed = await store.list(["--all"]);
			expect(includeClosed.some(issue => issue.id === closedTask.id)).toBe(true);

			const bugs = await store.list(["--type", "bug"]);
			expect(bugs).toHaveLength(1);
			expect(bugs[0]?.issue_type).toBe("bug");
		});
	});

	test("search and query match expected issues", async () => {
		await withStoreFixture(async ({ store }) => {
			const alpha = await store.create("Alpha Task", "first fixture item");
			await store.create("Beta Task", "second fixture item");
			await store.comment(alpha.id, "Needs alpha-specific follow-up");

			const searchMatches = await store.search("alpha", { includeComments: true });
			expect(searchMatches.map(issue => issue.id)).toContain(alpha.id);

			const queryMatches = await store.query("status=open alpha");
			expect(queryMatches.map(issue => issue.id)).toContain(alpha.id);
		});
	});

	test("depAdd and depTree persist dependency graph", async () => {
		await withStoreFixture(async ({ store }) => {
			const parent = await store.create("Parent Task");
			const child = await store.create("Child Task");
			await store.depAdd(child.id, parent.id);

			const depTree = (await store.depTree(child.id)) as {
				id?: string;
				tree?: { dependencies?: Array<{ id?: string }> };
			};
			expect(depTree.id).toBe(child.id);
			expect(Array.isArray(depTree.tree?.dependencies)).toBe(true);
			expect(depTree.tree?.dependencies?.[0]?.id).toBe(parent.id);
		});
	});

	test("close syncs cached dependency status on dependents and persists it", async () => {
		await withStoreFixture(async ({ store, sessionDir }) => {
			const blocker = await store.create("Blocker Task");
			const dependent = await store.create("Dependent Task", null, undefined, { depends_on: blocker.id });
			const beforeClose = await store.show(dependent.id);
			const beforeDependency = (
				beforeClose as {
					dependencies?: Array<{ id?: string; depends_on_id?: string; status?: string }>;
				}
			).dependencies?.find(dependency => dependency.id === blocker.id || dependency.depends_on_id === blocker.id);
			expect(beforeDependency?.status).toBe("open");

			await Bun.sleep(5);
			await store.close(blocker.id, "done");

			const afterClose = await store.show(dependent.id);
			const afterDependency = (
				afterClose as {
					dependencies?: Array<{ id?: string; depends_on_id?: string; status?: string; updated_at?: string }>;
				}
			).dependencies?.find(dependency => dependency.id === blocker.id || dependency.depends_on_id === blocker.id);
			expect(afterDependency?.status).toBe("closed");
			expect(afterDependency?.updated_at).toBe(afterClose.updated_at);
			expect(new Date(afterClose.updated_at).getTime()).toBeGreaterThan(new Date(beforeClose.updated_at).getTime());

			const reloaded = new JsonTaskStore({ cwd: process.cwd(), sessionDir, actor: "oms-reload" });
			const reloadedDependent = await reloaded.show(dependent.id);
			const reloadedDependency = (
				reloadedDependent as {
					dependencies?: Array<{ id?: string; depends_on_id?: string; status?: string }>;
				}
			).dependencies?.find(dependency => dependency.id === blocker.id || dependency.depends_on_id === blocker.id);
			expect(reloadedDependency?.status).toBe("closed");
		});
	});

	test("create wires depends_on from string and array inputs", async () => {
		await withStoreFixture(async ({ store }) => {
			const parentA = await store.create("Parent A");
			const parentB = await store.create("Parent B");
			const childFromString = await store.create("Child from string", null, undefined, {
				depends_on: parentA.id,
			});
			const childFromArray = await store.create("Child from array", null, undefined, {
				depends_on: [parentA.id, parentB.id, parentA.id],
			});

			const stringTree = (await store.depTree(childFromString.id)) as {
				tree?: {
					dependencies?: Array<{ id?: string }>;
				};
			};
			expect(stringTree.tree?.dependencies?.map(dep => dep.id)).toEqual([parentA.id]);

			const arrayTree = (await store.depTree(childFromArray.id)) as {
				tree?: {
					dependencies?: Array<{ id?: string }>;
				};
			};
			const dependencyIds = arrayTree.tree?.dependencies?.map(dep => dep.id) ?? [];
			expect(dependencyIds).toContain(parentA.id);
			expect(dependencyIds).toContain(parentB.id);
			expect(dependencyIds).toHaveLength(2);
		});
	});

	test("create with invalid depends_on does not persist the issue", async () => {
		await withStoreFixture(async ({ store }) => {
			await expect(
				store.create("Broken dependency create", null, undefined, { depends_on: "task-missing" }),
			).rejects.toThrow(/not found/i);
			const listed = await store.list(["--all"]);
			expect(listed.some(issue => issue.title === "Broken dependency create")).toBe(false);
		});
	});

	test("uses optional name for slugified IDs", async () => {
		await withStoreFixture(async ({ store }) => {
			const created = await store.create("Not used title", "desc", 2, { name: "My custom short name" });
			expect(created.id).toMatch(/^my-custom-short-[a-f0-9]{4}$/);
		});
	});

	test("uses title slugification when name is blank", async () => {
		await withStoreFixture(async ({ store }) => {
			const created = await store.create("Fix TypeScript build errors in test files", "desc", 2, { name: "   " });
			expect(created.id).toMatch(/^fix-typescript-b-[a-f0-9]{4}$/);
		});
	});

	test("falls back to legacy ID when slug cannot be derived", async () => {
		await withStoreFixture(async ({ store }) => {
			const created = await store.create("###", "desc", 2, { name: "@@@" });
			expect(created.id).toMatch(/^task-\d+-[a-f0-9]{6}$/);
		});
	});
	test("rejects empty title on create", async () => {
		await withStoreFixture(async ({ store }) => {
			expect(store.create("   ")).rejects.toThrow("create requires non-empty title");
		});
	});
});

describe("JsonTaskStore persistence", () => {
	test("loads existing store content from disk", async () => {
		await withStoreFixture(async ({ store, sessionDir }) => {
			const created = await store.create("Persisted Task", "persist me");
			await store.comment(created.id, "comment body");

			const reloaded = new JsonTaskStore({ cwd: process.cwd(), sessionDir, actor: "oms-reload" });
			const loaded = await reloaded.show(created.id);
			expect(loaded.title).toBe("Persisted Task");
			expect(Array.isArray(loaded.comments)).toBe(true);
			expect(loaded.comments?.[0]?.text).toContain("comment body");
		});
	});

	test("flushes mutations to per-task and index files", async () => {
		await withStoreFixture(async ({ store, storeFilePath }) => {
			const created = await store.create("Flush Task");
			const taskFilePath = path.join(path.dirname(storeFilePath), `${created.id}.json`);
			const taskRaw = await fs.readFile(taskFilePath, "utf8");
			expect(taskRaw).toContain(`"id": "${created.id}"`);
			expect(taskRaw).toContain('"title": "Flush Task"');
			const indexFilePath = path.join(path.dirname(storeFilePath), "_index.json");
			const indexRaw = await fs.readFile(indexFilePath, "utf8");
			const index = JSON.parse(indexRaw) as Record<string, unknown>;
			expect(index).toHaveProperty(created.id);
		});
	});

	test("serializes concurrent mutations without losing issues", async () => {
		await withStoreFixture(async ({ store }) => {
			await Promise.all([store.create("Concurrent A"), store.create("Concurrent B"), store.create("Concurrent C")]);

			const listed = await store.list(["--all"]);
			const titles = listed.map(issue => issue.title);
			expect(titles).toContain("Concurrent A");
			expect(titles).toContain("Concurrent B");
			expect(titles).toContain("Concurrent C");
		});
	});
});
describe("JsonTaskStore batch create", () => {
	test("creates a basic batch and returns key map", async () => {
		await withStoreFixture(async ({ store }) => {
			const result = await store.createBatch([
				{ key: "A", title: "Batch Issue A" },
				{ key: "B", title: "Batch Issue B" },
				{ key: "C", title: "Batch Issue C" },
			]);

			expect(result.issues).toHaveLength(3);
			expect(Object.keys(result.keyMap)).toEqual(["A", "B", "C"]);
			expect(result.issues.find(issue => issue.id === result.keyMap.A)?.title).toBe("Batch Issue A");
			expect(result.issues.find(issue => issue.id === result.keyMap.B)?.title).toBe("Batch Issue B");
			expect(result.issues.find(issue => issue.id === result.keyMap.C)?.title).toBe("Batch Issue C");
			expect(result.keyMap).toHaveProperty("A");
			expect(result.keyMap).toHaveProperty("B");
			expect(result.keyMap).toHaveProperty("C");
		});
	});

	test("resolves mixed batch key dependencies", async () => {
		await withStoreFixture(async ({ store }) => {
			const result = await store.createBatch([
				{ key: "upstream", title: "Batch Parent" },
				{ key: "child", title: "Batch Child", depends_on: ["upstream"] },
			]);
			const childId = result.keyMap.child as string;
			const upstreamId = result.keyMap.upstream as string;

			expect(childId).toBeDefined();
			expect(upstreamId).toBeDefined();
			expect(result.issues).toHaveLength(2);

			const childTree = (await store.depTree(childId)) as {
				tree?: {
					dependencies?: Array<{ id?: string }>;
				};
			};
			expect(childTree.tree?.dependencies?.some(dep => dep.id === upstreamId)).toBe(true);
		});
	});

	test("rejects circular dependencies", async () => {
		await withStoreFixture(async ({ store }) => {
			const operation = store.createBatch([
				{ key: "A", title: "Task A", depends_on: ["B"] },
				{ key: "B", title: "Task B", depends_on: ["C"] },
				{ key: "C", title: "Task C", depends_on: ["A"] },
			]);
			await expect(operation).rejects.toThrow(/circular/i);
			expect(await store.list(["--all"])).toHaveLength(0);
		});
	});

	test("supports mixed dependencies with existing issue IDs", async () => {
		await withStoreFixture(async ({ store }) => {
			const existing = await store.create("Existing Issue", "for dependency");

			const result = await store.createBatch([
				{ key: "A", title: "Batch Depends on Existing", depends_on: [existing.id] },
				{ key: "B", title: "Batch Depends on Batch", depends_on: ["A"] },
			]);

			const aId = result.keyMap.A as string;
			const bId = result.keyMap.B as string;
			expect(result.issues).toHaveLength(2);

			const aTree = (await store.depTree(aId)) as {
				tree?: {
					dependencies?: Array<{ id?: string }>;
				};
			};
			expect(aTree.tree?.dependencies?.some(dep => dep.id === existing.id)).toBe(true);

			const bTree = (await store.depTree(bId)) as {
				tree?: {
					dependencies?: Array<{ id?: string }>;
				};
			};
			expect(bTree.tree?.dependencies?.some(dep => dep.id === aId)).toBe(true);
		});
	});

	describe("validation failures", () => {
		test("rejects empty batch", async () => {
			await withStoreFixture(async ({ store }) => {
				await expect(store.createBatch([])).rejects.toThrow(/at least one issue/i);
				expect(await store.list(["--all"])).toHaveLength(0);
			});
		});

		test("rejects duplicate batch keys", async () => {
			await withStoreFixture(async ({ store }) => {
				await expect(
					store.createBatch([
						{ key: "A", title: "First" },
						{ key: "A", title: "Second" },
					]),
				).rejects.toThrow(/duplicate key/i);
				expect(await store.list(["--all"])).toHaveLength(0);
			});
		});

		test("rejects unknown dependencies", async () => {
			await withStoreFixture(async ({ store }) => {
				await expect(
					store.createBatch([{ key: "A", title: "Orphan", depends_on: ["nonexistent"] }]),
				).rejects.toThrow(/unknown dependency/i);
				expect(await store.list(["--all"])).toHaveLength(0);
			});
		});
	});

	test("is atomic when a batch member is invalid", async () => {
		await withStoreFixture(async ({ store }) => {
			await expect(
				store.createBatch([
					{ key: "A", title: "Valid one" },
					{ key: "B", title: "   " },
				]),
			).rejects.toThrow(/empty title/i);
			expect(await store.list(["--all"])).toHaveLength(0);
		});
	});
});
