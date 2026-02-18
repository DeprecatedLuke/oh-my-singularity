import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ReplicaManager } from "./manager";

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

async function seedProjectRoot(projectRoot: string, opts?: { includeOms?: boolean }): Promise<void> {
	await fs.mkdir(path.join(projectRoot, "src"), { recursive: true });
	await Bun.write(path.join(projectRoot, "src", "app.ts"), "export const APP = true;\n");
	await Bun.write(path.join(projectRoot, "README.md"), "replica fixture\n");

	await fs.mkdir(path.join(projectRoot, "node_modules", "fixture-package"), { recursive: true });
	await Bun.write(path.join(projectRoot, "node_modules", "fixture-package", "index.js"), "module.exports = 1;\n");

	await fs.mkdir(path.join(projectRoot, ".git", "objects"), { recursive: true });
	await Bun.write(path.join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");

	await fs.mkdir(path.join(projectRoot, "out"), { recursive: true });
	await Bun.write(path.join(projectRoot, "out", "generated.txt"), "build output\n");

	await fs.mkdir(path.join(projectRoot, "dist"), { recursive: true });
	await Bun.write(path.join(projectRoot, "dist", "bundle.js"), "console.log('dist');\n");

	if (opts?.includeOms) {
		await fs.mkdir(path.join(projectRoot, ".oms"), { recursive: true });
		await Bun.write(path.join(projectRoot, ".oms", "config.json"), "{}\n");
	}
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

describe("ReplicaManager", () => {
	test("createReplica copies project with excludes and required symlinks", async () => {
		await withReplicaFixture(async ({ projectRoot, manager }) => {
			await seedProjectRoot(projectRoot, { includeOms: true });

			const replicaDir = await manager.createReplica(" task / alpha::beta ");
			expect(path.basename(replicaDir)).toBe("task-alpha-beta");

			expect(await pathExists(path.join(replicaDir, "src", "app.ts"))).toBe(true);
			expect(await pathExists(path.join(replicaDir, "README.md"))).toBe(true);
			expect(await pathExists(path.join(replicaDir, "out"))).toBe(false);
			expect(await pathExists(path.join(replicaDir, "dist"))).toBe(false);
			expect(await pathExists(path.join(replicaDir, ".oms"))).toBe(false);

			const nodeModulesLinkPath = path.join(replicaDir, "node_modules");
			const gitLinkPath = path.join(replicaDir, ".git");

			expect((await fs.lstat(nodeModulesLinkPath)).isSymbolicLink()).toBe(true);
			expect((await fs.lstat(gitLinkPath)).isSymbolicLink()).toBe(true);
			expect(await fs.readlink(nodeModulesLinkPath)).toBe(path.resolve(projectRoot, "node_modules"));
			expect(await fs.readlink(gitLinkPath)).toBe(path.resolve(projectRoot, ".git"));
		});
	});

	test("createReplica creates .oms/replica even when .oms does not yet exist", async () => {
		await withReplicaFixture(async ({ projectRoot, manager }) => {
			await seedProjectRoot(projectRoot);
			expect(await pathExists(path.join(projectRoot, ".oms"))).toBe(false);

			await manager.createReplica("without-oms");
			expect(await pathExists(path.join(projectRoot, ".oms", "replica"))).toBe(true);
		});
	});

	test("replicaExists/listReplicas/destroyReplica lifecycle", async () => {
		await withReplicaFixture(async ({ projectRoot, manager }) => {
			await seedProjectRoot(projectRoot);

			const taskOne = "task:one";
			const taskTwo = "task two";

			expect(await manager.replicaExists(taskOne)).toBe(false);
			await manager.createReplica(taskOne);
			await manager.createReplica(taskTwo);

			expect(await manager.replicaExists(taskOne)).toBe(true);
			expect(await manager.replicaExists(taskTwo)).toBe(true);
			expect(await manager.listReplicas()).toEqual(["task-one", "task-two"]);

			await manager.destroyReplica(taskOne);
			expect(await manager.replicaExists(taskOne)).toBe(false);
			expect(await manager.listReplicas()).toEqual(["task-two"]);
		});
	});

	test("createReplica deduplicates concurrent calls for the same task", async () => {
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
		});
	});
});
