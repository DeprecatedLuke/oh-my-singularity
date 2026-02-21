import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReplicaManager, sanitizeReplicaTaskId } from "./manager";

const IS_LINUX = process.platform === "linux";

type ReplicaFixture = {
	projectRoot: string;
	manager: ReplicaManager;
};

function isNotFoundError(err: unknown): err is NodeJS.ErrnoException {
	return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.lstat(targetPath);
		return true;
	} catch (err) {
		if (isNotFoundError(err)) return false;
		throw err;
	}
}

async function seedProjectRoot(projectRoot: string): Promise<void> {
	await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
	await Bun.write(path.join(projectRoot, "src", "app.ts"), "export const APP = true;\n");
	await Bun.write(path.join(projectRoot, "README.md"), "replica fixture\n");

	await fs.mkdir(path.join(projectRoot, "node_modules", "fixture-package"), { recursive: true });
	await Bun.write(path.join(projectRoot, "node_modules", "fixture-package", "index.js"), "module.exports = 1;\n");

	await fs.mkdir(path.join(projectRoot, ".git", "objects"), { recursive: true });
	await Bun.write(path.join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
}

async function withReplicaFixture(run: (fixture: ReplicaFixture) => Promise<void>): Promise<void> {
	const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oms-replica-manager-test-"));
	const manager = new ReplicaManager({ projectRoot });
	try {
		await run({ projectRoot, manager });
	} finally {
		await fs.rm(projectRoot, { recursive: true, force: true });
	}
}

/**
 * Check if we can actually mount fuse-overlayfs.
 * Returns false if not Linux or if a test mount fails.
 */
async function canMountOverlay(): Promise<boolean> {
	if (!IS_LINUX) return false;
	const { $ } = await import("bun");
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-overlay-probe-"));
	try {
		const lower = path.join(tmpDir, "lower");
		const upper = path.join(tmpDir, "upper");
		const work = path.join(tmpDir, "work");
		const merged = path.join(tmpDir, "merged");
		await fs.mkdir(lower, { recursive: true });
		await fs.mkdir(upper, { recursive: true });
		await fs.mkdir(work, { recursive: true });
		await fs.mkdir(merged, { recursive: true });
		const result = await $`fuse-overlayfs -o lowerdir=${lower},upperdir=${upper},workdir=${work} ${merged}`
			.quiet()
			.nothrow();
		if (result.exitCode === 0) {
			await $`fusermount -u ${merged}`.quiet().nothrow();
			return true;
		}
		return false;
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true });
	}
}

// Cached probe result
let overlayCapable: boolean | null = null;

async function requireOverlayCapability(): Promise<boolean> {
	if (overlayCapable === null) {
		overlayCapable = await canMountOverlay();
	}
	return overlayCapable;
}

describe("sanitizeReplicaTaskId", () => {
	test("sanitizes special characters", () => {
		expect(sanitizeReplicaTaskId(" task / alpha::beta ")).toBe("task-alpha-beta");
		expect(sanitizeReplicaTaskId("parallel/task")).toBe("parallel-task");
		expect(sanitizeReplicaTaskId("task:one")).toBe("task-one");
		expect(sanitizeReplicaTaskId("task two")).toBe("task-two");
		expect(sanitizeReplicaTaskId("")).toBe("task");
	});
});

describe("ReplicaManager", () => {
	test("getReplicaDir returns merged/ subdirectory path", () => {
		const manager = new ReplicaManager({ projectRoot: "/tmp/project" });
		const dir = manager.getReplicaDir("my-task");
		expect(dir).toEndWith("/my-task/merged");
	});

	test("getReplicaUpperDir returns upper/ subdirectory path", () => {
		const manager = new ReplicaManager({ projectRoot: "/tmp/project" });
		const dir = manager.getReplicaUpperDir("my-task");
		expect(dir).toEndWith("/my-task/upper");
	});

	test("createReplica throws on non-Linux", async () => {
		if (IS_LINUX) return; // skip on Linux — it won't throw there
		const manager = new ReplicaManager({ projectRoot: "/tmp/project" });
		expect(manager.createReplica("task-1")).rejects.toThrow("only supported on Linux");
	});

	test("createReplica throws when fuse-overlayfs binary is missing", async () => {
		if (!IS_LINUX) return; // platform guard fires first on non-Linux
		const originalWhich = Bun.which;
		Bun.which = (name: string) => (name === "fuse-overlayfs" ? null : originalWhich(name));
		try {
			const manager = new ReplicaManager({ projectRoot: "/tmp/project" });
			await expect(manager.createReplica("task-1")).rejects.toThrow("fuse-overlayfs binary not found");
		} finally {
			Bun.which = originalWhich;
		}
	});

	test("listReplicas returns empty array when replica root does not exist", async () => {
		await withReplicaFixture(async ({ manager }) => {
			const list = await manager.listReplicas();
			expect(list).toEqual([]);
		});
	});

	test("replicaExists returns false for non-existent replica", async () => {
		await withReplicaFixture(async ({ manager }) => {
			expect(await manager.replicaExists("no-such-task")).toBe(false);
		});
	});

	test("withMergeLock serializes concurrent merge operations", async () => {
		await withReplicaFixture(async ({ manager }) => {
			const order: number[] = [];

			const op1 = manager.withMergeLock(async () => {
				await Bun.sleep(50);
				order.push(1);
			});

			const op2 = manager.withMergeLock(async () => {
				order.push(2);
			});

			const op3 = manager.withMergeLock(async () => {
				order.push(3);
			});

			await Promise.all([op1, op2, op3]);
			expect(order).toEqual([1, 2, 3]);
		});
	});

	test("withMergeLock continues after a failed merge", async () => {
		await withReplicaFixture(async ({ manager }) => {
			const order: number[] = [];

			const op1 = manager
				.withMergeLock(async () => {
					order.push(1);
					throw new Error("merge failed");
				})
				.catch(() => {});

			const op2 = manager.withMergeLock(async () => {
				order.push(2);
				return "ok";
			});

			await Promise.all([op1, op2]);
			expect(order).toEqual([1, 2]);
			expect(await op2).toBe("ok");
		});
	});
});

describe("ReplicaManager (overlay mount)", () => {
	test("full lifecycle: create, exists, list, destroy", async () => {
		if (!(await requireOverlayCapability())) {
			console.log("Skipping overlay mount test — not Linux or fuse-overlayfs unavailable");
			return;
		}

		await withReplicaFixture(async ({ projectRoot, manager }) => {
			await seedProjectRoot(projectRoot);

			const taskOne = "task:one";
			const taskTwo = "task two";

			expect(await manager.replicaExists(taskOne)).toBe(false);

			const replicaDir1 = await manager.createReplica(taskOne);
			const replicaDir2 = await manager.createReplica(taskTwo);

			// Returned path is the merged/ subdirectory
			expect(replicaDir1).toEndWith("/task-one/merged");
			expect(replicaDir2).toEndWith("/task-two/merged");

			// Overlay makes project files visible in merged dir
			expect(await pathExists(path.join(replicaDir1, "src", "app.ts"))).toBe(true);
			expect(await pathExists(path.join(replicaDir1, "README.md"))).toBe(true);

			// node_modules and .git are visible through overlay (not symlinks)
			expect(await pathExists(path.join(replicaDir1, "node_modules", "fixture-package", "index.js"))).toBe(true);
			expect(await pathExists(path.join(replicaDir1, ".git", "HEAD"))).toBe(true);

			// replicaExists checks /proc/mounts
			expect(await manager.replicaExists(taskOne)).toBe(true);
			expect(await manager.replicaExists(taskTwo)).toBe(true);
			expect(await manager.listReplicas()).toEqual(["task-one", "task-two"]);

			// Writes go to upper dir only
			await Bun.write(path.join(replicaDir1, "new-file.txt"), "from replica\n");
			const upperDir = manager.getReplicaUpperDir(taskOne);
			expect(await pathExists(path.join(upperDir, "new-file.txt"))).toBe(true);
			// Original project root is untouched
			expect(await pathExists(path.join(projectRoot, "new-file.txt"))).toBe(false);

			// Destroy and verify cleanup
			await manager.destroyReplica(taskOne);
			expect(await manager.replicaExists(taskOne)).toBe(false);
			expect(await manager.listReplicas()).toEqual(["task-two"]);

			// Clean up second replica
			await manager.destroyReplica(taskTwo);
		});
	});

	test("createReplica deduplicates concurrent calls for the same task", async () => {
		if (!(await requireOverlayCapability())) {
			console.log("Skipping overlay mount test — not Linux or fuse-overlayfs unavailable");
			return;
		}

		await withReplicaFixture(async ({ projectRoot, manager }) => {
			await seedProjectRoot(projectRoot);

			const taskId = "parallel/task";
			const [first, second, third] = await Promise.all([
				manager.createReplica(taskId),
				manager.createReplica(taskId),
				manager.createReplica(taskId),
			]);

			expect(first).toBe(second);
			expect(second).toBe(third);
			expect(await manager.listReplicas()).toEqual(["parallel-task"]);

			await manager.destroyReplica(taskId);
		});
	});

	test("destroyReplica handles already-unmounted replica gracefully", async () => {
		if (!(await requireOverlayCapability())) {
			console.log("Skipping overlay mount test — not Linux or fuse-overlayfs unavailable");
			return;
		}

		await withReplicaFixture(async ({ projectRoot, manager }) => {
			await seedProjectRoot(projectRoot);

			await manager.createReplica("crash-task");

			// Manually unmount to simulate crash recovery scenario
			const { $ } = await import("bun");
			const mergedDir = manager.getReplicaDir("crash-task");
			await $`fusermount -u ${mergedDir}`.quiet().nothrow();

			// destroyReplica should still work — swallows umount error and cleans up dirs
			await manager.destroyReplica("crash-task");
			expect(await manager.replicaExists("crash-task")).toBe(false);
			expect(await manager.listReplicas()).toEqual([]);
		});
	});
});
