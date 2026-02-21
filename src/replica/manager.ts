import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { logger } from "../utils";

export interface ReplicaManagerOptions {
	projectRoot: string;
	replicaRootDir?: string;
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

/**
 * Check whether a given path is an active overlay mount by parsing `/proc/mounts`.
 * Returns `true` only if there is an overlay-type entry whose mountpoint matches exactly.
 */
async function isOverlayMounted(mountpoint: string): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		const mounts = await Bun.file("/proc/mounts").text();
		const resolved = path.resolve(mountpoint);
		for (const line of mounts.split("\n")) {
			// Format: device mountpoint fstype options dump pass
			const parts = line.split(" ");
			if (parts.length < 3) continue;
			if (parts[2] === "fuse.fuse-overlayfs" && path.resolve(parts[1]) === resolved) {
				return true;
			}
		}
		return false;
	} catch {
		return false;
	}
}

export class ReplicaManager {
	#projectRoot: string;
	#replicaRootDir: string;
	#createInFlight = new Map<string, Promise<string>>();
	#mergeLock: Promise<void> = Promise.resolve();

	constructor(options: ReplicaManagerOptions) {
		this.#projectRoot = path.resolve(options.projectRoot);
		this.#replicaRootDir = path.resolve(options.replicaRootDir ?? path.join(this.#projectRoot, ".oms", "replica"));
	}

	getReplicaDir(taskId: string): string {
		const sanitizedTaskId = sanitizeReplicaTaskId(taskId);
		return path.join(this.#replicaRootDir, sanitizedTaskId, "merged");
	}

	/**
	 * Return the upper dir path for a replica. This is where OverlayFS stores
	 * changed files — useful for the merger to know exactly what was modified.
	 */
	getReplicaUpperDir(taskId: string): string {
		const sanitizedTaskId = sanitizeReplicaTaskId(taskId);
		return path.join(this.#replicaRootDir, sanitizedTaskId, "upper");
	}

	async createReplica(taskId: string): Promise<string> {
		if (process.platform !== "linux") {
			throw new Error("fuse-overlayfs replicas are only supported on Linux");
		}

		if (!Bun.which("fuse-overlayfs")) {
			throw new Error(
				"fuse-overlayfs binary not found. Install it (e.g. `apt install fuse-overlayfs` or `pacman -S fuse-overlayfs`) to use replicas.",
			);
		}

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
		const sanitizedTaskId = sanitizeReplicaTaskId(taskId);
		const taskBaseDir = path.join(this.#replicaRootDir, sanitizedTaskId);
		const mergedDir = path.join(taskBaseDir, "merged");

		// Attempt unmount first; swallow errors if not mounted (crash recovery case)
		if (process.platform === "linux") {
			const result = await $`fusermount -u ${mergedDir}`.quiet().nothrow();
			if (result.exitCode !== 0) {
				logger.debug("replica/manager.ts: fusermount returned non-zero (may not be mounted)", {
					exitCode: result.exitCode,
					mergedDir,
				});
			}
		}

		await fs.rm(taskBaseDir, { recursive: true, force: true });
	}

	async replicaExists(taskId: string): Promise<boolean> {
		const mergedDir = this.getReplicaDir(taskId);
		return await isOverlayMounted(mergedDir);
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

	/**
	 * Serialize merge operations. Only one merge into the root worktree
	 * can happen at a time. Returns a promise that resolves when the
	 * provided merge function completes.
	 */
	async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const previousLock = this.#mergeLock;
		this.#mergeLock = promise.then(
			() => {},
			() => {},
		);
		await previousLock;
		try {
			const result = await fn();
			resolve(result);
			return result;
		} catch (err) {
			reject(err);
			throw err;
		}
	}

	async #createReplicaInternal(sanitizedTaskId: string): Promise<string> {
		const taskBaseDir = path.join(this.#replicaRootDir, sanitizedTaskId);
		const upperDir = path.join(taskBaseDir, "upper");
		const workDir = path.join(taskBaseDir, "work");
		const mergedDir = path.join(taskBaseDir, "merged");

		// If already mounted, return early
		if (await isOverlayMounted(mergedDir)) return mergedDir;

		// Clean up any leftover state from a crashed previous attempt
		await fs.rm(taskBaseDir, { recursive: true, force: true });

		await fs.mkdir(upperDir, { recursive: true });
		await fs.mkdir(workDir, { recursive: true });
		await fs.mkdir(mergedDir, { recursive: true });

		const result =
			await $`fuse-overlayfs -o lowerdir=${this.#projectRoot},upperdir=${upperDir},workdir=${workDir} ${mergedDir}`
				.quiet()
				.nothrow();

		if (result.exitCode !== 0) {
			const stderr = result.stderr.toString().trim();
			// Clean up dirs on mount failure
			await fs.rm(taskBaseDir, { recursive: true, force: true });
			throw new Error(`fuse-overlayfs mount failed (exit ${result.exitCode}): ${stderr}`);
		}

		return mergedDir;
	}
}
