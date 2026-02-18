import { describe, expect, test } from "bun:test";

import { MergerQueue } from "./merger-queue";

describe("MergerQueue", () => {
	test("enqueue deduplicates by task id", () => {
		const queue = new MergerQueue();

		const first = queue.enqueue(" task-a ", " /tmp/replica/task-a ", 1000);
		const second = queue.enqueue("task-a", "/tmp/replica/task-a-second", 2000);

		expect(first).toEqual({
			taskId: "task-a",
			replicaDir: "/tmp/replica/task-a",
			enqueuedAt: 1000,
		});
		expect(second).toBe(first);
		expect(queue.size()).toBe(1);
	});

	test("dequeue returns head and removes it from queue/set", () => {
		const queue = new MergerQueue();
		queue.enqueue("task-a", "/tmp/replica/task-a", 1);
		queue.enqueue("task-b", "/tmp/replica/task-b", 2);

		const dequeued = queue.dequeue();

		expect(dequeued).toEqual({
			taskId: "task-a",
			replicaDir: "/tmp/replica/task-a",
			enqueuedAt: 1,
		});
		expect(queue.hasTask("task-a")).toBe(false);
		expect(queue.peek()).toEqual({
			taskId: "task-b",
			replicaDir: "/tmp/replica/task-b",
			enqueuedAt: 2,
		});
	});

	test("remove deletes an entry from the middle of the queue", () => {
		const queue = new MergerQueue();
		queue.enqueue("task-a", "/tmp/replica/task-a", 1);
		queue.enqueue("task-b", "/tmp/replica/task-b", 2);
		queue.enqueue("task-c", "/tmp/replica/task-c", 3);

		const removed = queue.remove("task-b");

		expect(removed).toEqual({
			taskId: "task-b",
			replicaDir: "/tmp/replica/task-b",
			enqueuedAt: 2,
		});
		expect(queue.list()).toEqual([
			{ taskId: "task-a", replicaDir: "/tmp/replica/task-a", enqueuedAt: 1 },
			{ taskId: "task-c", replicaDir: "/tmp/replica/task-c", enqueuedAt: 3 },
		]);
	});

	test("peek reads head without removing it", () => {
		const queue = new MergerQueue();
		queue.enqueue("task-a", "/tmp/replica/task-a", 1);

		const peeked = queue.peek();

		expect(peeked).toEqual({
			taskId: "task-a",
			replicaDir: "/tmp/replica/task-a",
			enqueuedAt: 1,
		});
		expect(queue.size()).toBe(1);
		expect(queue.hasTask("task-a")).toBe(true);
	});

	test("hasTask/isEmpty/size reflect queue state", () => {
		const queue = new MergerQueue();
		expect(queue.isEmpty()).toBe(true);
		expect(queue.size()).toBe(0);
		expect(queue.hasTask("task-a")).toBe(false);

		queue.enqueue("task-a", "/tmp/replica/task-a", 1);
		expect(queue.isEmpty()).toBe(false);
		expect(queue.size()).toBe(1);
		expect(queue.hasTask("task-a")).toBe(true);

		queue.dequeue();
		expect(queue.isEmpty()).toBe(true);
		expect(queue.size()).toBe(0);
	});

	test("dequeue preserves FIFO ordering", () => {
		const queue = new MergerQueue();
		queue.enqueue("task-a", "/tmp/replica/task-a", 1);
		queue.enqueue("task-b", "/tmp/replica/task-b", 2);

		expect(queue.dequeue()?.taskId).toBe("task-a");
		expect(queue.dequeue()?.taskId).toBe("task-b");
		expect(queue.dequeue()).toBeNull();
	});

	test("enqueue rejects blank taskId or replicaDir", () => {
		const queue = new MergerQueue();

		expect(queue.enqueue("", "/tmp/replica/task-a")).toBeNull();
		expect(queue.enqueue("   ", "/tmp/replica/task-a")).toBeNull();
		expect(queue.enqueue("task-a", "")).toBeNull();
		expect(queue.enqueue("task-a", "   ")).toBeNull();
		expect(queue.size()).toBe(0);
	});
});
