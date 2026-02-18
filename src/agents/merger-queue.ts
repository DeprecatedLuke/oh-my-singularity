export interface MergerQueueEntry {
	taskId: string;
	replicaDir: string;
	enqueuedAt: number;
}

function normalizeToken(value: string): string {
	return value.trim();
}

export class MergerQueue {
	#entries: MergerQueueEntry[] = [];
	#entriesByTaskId = new Map<string, MergerQueueEntry>();

	enqueue(taskId: string, replicaDir: string, enqueuedAt = Date.now()): MergerQueueEntry | null {
		const normalizedTaskId = normalizeToken(taskId);
		const normalizedReplicaDir = normalizeToken(replicaDir);
		if (!normalizedTaskId || !normalizedReplicaDir) return null;

		const existing = this.#entriesByTaskId.get(normalizedTaskId);
		if (existing) return existing;

		const entry: MergerQueueEntry = {
			taskId: normalizedTaskId,
			replicaDir: normalizedReplicaDir,
			enqueuedAt,
		};

		this.#entries.push(entry);
		this.#entriesByTaskId.set(entry.taskId, entry);
		return entry;
	}

	peek(): MergerQueueEntry | null {
		return this.#entries[0] ?? null;
	}

	dequeue(): MergerQueueEntry | null {
		const head = this.#entries.shift() ?? null;
		if (!head) return null;
		this.#entriesByTaskId.delete(head.taskId);
		return head;
	}

	remove(taskId: string): MergerQueueEntry | null {
		const normalizedTaskId = normalizeToken(taskId);
		if (!normalizedTaskId) return null;

		const existing = this.#entriesByTaskId.get(normalizedTaskId);
		if (!existing) return null;

		this.#entriesByTaskId.delete(normalizedTaskId);
		const index = this.#entries.findIndex(entry => entry.taskId === normalizedTaskId);
		if (index >= 0) this.#entries.splice(index, 1);
		return existing;
	}

	hasTask(taskId: string): boolean {
		const normalizedTaskId = normalizeToken(taskId);
		if (!normalizedTaskId) return false;
		return this.#entriesByTaskId.has(normalizedTaskId);
	}

	isEmpty(): boolean {
		return this.#entries.length === 0;
	}

	size(): number {
		return this.#entries.length;
	}

	list(): MergerQueueEntry[] {
		return [...this.#entries];
	}
}
