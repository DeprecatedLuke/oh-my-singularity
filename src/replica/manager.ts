import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { logger } from "../utils";

export const DEFAULT_REPLICA_EXCLUDES = [".oms/", "node_modules/", ".git/", "out/", "dist/"] as const;

export interface ReplicaManagerOptions {
	projectRoot: string;
	replicaRootDir?: string;
	excludes?: string[];
}

function normalizeRelativePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/+$/, "");
}

function isNotFoundError(err: unknown): err is NodeJS.ErrnoException {
	return Boolean(err && typeof err === "object" && "code" in err && err.code === "ENOENT");
}

export function sanitizeReplicaTaskId(taskId: string): string {
	const sanitized = taskId
		.trim()
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "task";
}

export class ReplicaManager {
	#projectRoot: string;
	#replicaRootDir: string;
	#excludePrefixes: string[];
	#createInFlight = new Map<string, Promise<string>>();

	constructor(options: ReplicaManagerOptions) {
		this.#projectRoot = path.resolve(options.projectRoot);
		this.#replicaRootDir = path.resolve(options.replicaRootDir ?? path.join(this.#projectRoot, ".oms", "replica"));
		this.#excludePrefixes = this.#normalizeExcludes(options.excludes ?? [...DEFAULT_REPLICA_EXCLUDES]);
	}

	getReplicaDir(taskId: string): string {
		const sanitizedTaskId = sanitizeReplicaTaskId(taskId);
		return this.#replicaDirFromSanitizedTaskId(sanitizedTaskId);
	}

	async createReplica(taskId: string): Promise<string> {
		const sanitizedTaskId = sanitizeReplicaTaskId(taskId);
		const inFlight = this.#createInFlight.get(sanitizedTaskId);
		if (inFlight) return await inFlight;

		const createPromise = this.#createReplicaInternal(sanitizedTaskId).finally(() => {
			const current = this.#createInFlight.get(sanitizedTaskId);
			if (current === createPromise) this.#createInFlight.delete(sanitizedTaskId);
		});
		this.#createInFlight.set(sanitizedTaskId, createPromise);
		return await createPromise;
	}

	async destroyReplica(taskId: string): Promise<void> {
		await fs.rm(this.getReplicaDir(taskId), { recursive: true, force: true });
	}

	async replicaExists(taskId: string): Promise<boolean> {
		return await this.#replicaExistsByPath(this.getReplicaDir(taskId));
	}

	async listReplicas(): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.#replicaRootDir, { withFileTypes: true });
			return entries
				.filter(entry => entry.isDirectory())
				.map(entry => entry.name)
				.sort((a, b) => a.localeCompare(b));
		} catch (err) {
			if (isNotFoundError(err)) return [];
			throw err;
		}
	}

	#normalizeExcludes(excludes: readonly string[]): string[] {
		const seen = new Set<string>();
		const normalized: string[] = [];
		for (const exclude of excludes) {
			const normalizedExclude = normalizeRelativePath(exclude);
			if (!normalizedExclude || seen.has(normalizedExclude)) continue;
			seen.add(normalizedExclude);
			normalized.push(normalizedExclude);
		}
		return normalized;
	}

	#replicaDirFromSanitizedTaskId(sanitizedTaskId: string): string {
		return path.join(this.#replicaRootDir, sanitizedTaskId);
	}

	async #createReplicaInternal(sanitizedTaskId: string): Promise<string> {
		const replicaDir = this.#replicaDirFromSanitizedTaskId(sanitizedTaskId);
		if (await this.#replicaExistsByPath(replicaDir)) return replicaDir;

		await fs.mkdir(this.#replicaRootDir, { recursive: true });
		await fs.mkdir(replicaDir, { recursive: true });

		await this.#copyProjectRoot(replicaDir);
		await Promise.all([
			this.#ensureAbsoluteSymlink(
				path.join(this.#projectRoot, "node_modules"),
				path.join(replicaDir, "node_modules"),
			),
			this.#ensureAbsoluteSymlink(path.join(this.#projectRoot, ".git"), path.join(replicaDir, ".git")),
		]);

		return replicaDir;
	}

	async #replicaExistsByPath(replicaDir: string): Promise<boolean> {
		try {
			const stat = await fs.stat(replicaDir);
			return stat.isDirectory();
		} catch (err) {
			if (isNotFoundError(err)) return false;
			throw err;
		}
	}

	async #copyProjectRoot(replicaDir: string): Promise<void> {
		const rsyncBinary = Bun.which("rsync");
		if (rsyncBinary) {
			const sourceDir = `${this.#projectRoot}${path.sep}`;
			const destinationDir = `${replicaDir}${path.sep}`;
			const excludeArgs = this.#excludePrefixes.map(exclude => `--exclude=${exclude}/`);
			const result = await $`${rsyncBinary} -a --delete ${excludeArgs} ${sourceDir} ${destinationDir}`
				.quiet()
				.nothrow();
			if (result.exitCode === 0) return;

			logger.warn("replica/manager.ts: rsync copy failed, using recursive-copy fallback", {
				exitCode: result.exitCode,
				replicaDir,
			});
		}

		await this.#copyDirectoryRecursive(this.#projectRoot, replicaDir, "");
	}

	#shouldExclude(relativePath: string): boolean {
		const normalizedRelativePath = normalizeRelativePath(relativePath);
		if (!normalizedRelativePath) return false;
		return this.#excludePrefixes.some(
			exclude => normalizedRelativePath === exclude || normalizedRelativePath.startsWith(`${exclude}/`),
		);
	}

	async #copyDirectoryRecursive(sourceDir: string, destinationDir: string, relativePath: string): Promise<void> {
		const entries = await fs.readdir(sourceDir, { withFileTypes: true });
		for (const entry of entries) {
			const nextRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			if (this.#shouldExclude(nextRelativePath)) continue;

			const sourcePath = path.join(sourceDir, entry.name);
			const destinationPath = path.join(destinationDir, entry.name);

			if (entry.isDirectory()) {
				await fs.mkdir(destinationPath, { recursive: true });
				await this.#copyDirectoryRecursive(sourcePath, destinationPath, nextRelativePath);
				continue;
			}

			if (entry.isSymbolicLink()) {
				const target = await fs.readlink(sourcePath);
				await fs.symlink(target, destinationPath);
				continue;
			}

			if (!entry.isFile()) {
				logger.debug("replica/manager.ts: skipping unsupported filesystem entry while copying replica", {
					entry: nextRelativePath,
				});
				continue;
			}

			await fs.cp(sourcePath, destinationPath, { force: true });
		}
	}

	async #ensureAbsoluteSymlink(targetPath: string, symlinkPath: string): Promise<void> {
		await fs.rm(symlinkPath, { recursive: true, force: true });
		await fs.symlink(path.resolve(targetPath), symlinkPath);
	}
}
