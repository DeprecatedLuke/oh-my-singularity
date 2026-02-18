import { EventEmitter } from "node:events";
import { INTERVAL_POLLER_MIN_MS, LIMIT_POLLER_ACTIVITY_DEFAULT, LIMIT_POLLER_SEEN_ACTIVITY } from "../config/constants";

import type { TaskStoreClient, TaskStoreEvent } from "./client";
import type { TaskActivityEvent, TaskIssue } from "./types";

export interface TaskPollerOptions {
	client: TaskStoreClient;
	intervalMs: number;
	activityLimit?: number;
	includeIssueList?: boolean;
	includeActivity?: boolean;
}

export interface TaskPollerLike {
	readonly readySnapshot: readonly TaskIssue[];
	readonly issuesSnapshot: readonly TaskIssue[];
	start(): void;
	stop(): void;
	setIntervalMs(intervalMs: number): void;
	on(event: "issues-changed", listener: (issues: TaskIssue[]) => void): this;
	on(event: "ready-changed", listener: (ready: TaskIssue[]) => void): this;
	on(event: "activity", listener: (activity: TaskActivityEvent[]) => void): this;
	on(event: "error", listener: (err: unknown) => void): this;
	on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

function readySignature(issues: readonly TaskIssue[]): string {
	return issues
		.map(issue => `${issue.id}:${issue.updated_at}:${issue.status}:${issue.assignee ?? ""}`)
		.sort()
		.join("|");
}

function activityKey(event: TaskActivityEvent): string {
	if (typeof event.id === "string" && event.id) return `id:${event.id}`;
	if (typeof event.issue_id === "string" && event.issue_id && typeof event.created_at === "string") {
		return `issue:${event.issue_id}|type:${String(event.type ?? "")}|at:${event.created_at}`;
	}
	if (typeof event.created_at === "string") return `at:${event.created_at}|${JSON.stringify(event)}`;
	return `json:${JSON.stringify(event)}`;
}

export class TaskPoller extends EventEmitter implements TaskPollerLike {
	private readonly client: TaskStoreClient;
	private intervalMs: number;
	private readonly activityLimit: number;

	private timer: Timer | null = null;
	private tickInFlight = false;
	private unsubscribe: (() => void) | null = null;
	private usingSubscription = false;

	private lastReadySig: string | null = null;
	private _readySnapshot: TaskIssue[] = [];

	private includeIssueList: boolean;
	private includeActivity: boolean;
	private lastIssuesSig: string | null = null;
	private _issuesSnapshot: TaskIssue[] = [];

	private activityInitialized = false;
	private lastErrorSig: string | null = null;

	private readonly seenActivityKeys = new Set<string>();
	private readonly seenActivityOrder: string[] = [];
	private readonly maxSeenActivity = LIMIT_POLLER_SEEN_ACTIVITY;

	constructor(options: TaskPollerOptions) {
		super();
		this.client = options.client;
		this.intervalMs = Math.max(INTERVAL_POLLER_MIN_MS, Math.trunc(options.intervalMs));
		this.activityLimit = options.activityLimit ?? LIMIT_POLLER_ACTIVITY_DEFAULT;
		this.includeIssueList = options.includeIssueList ?? true;
		this.includeActivity = options.includeActivity ?? false;
	}

	get readySnapshot(): readonly TaskIssue[] {
		return this._readySnapshot;
	}

	get issuesSnapshot(): readonly TaskIssue[] {
		return this._issuesSnapshot;
	}

	setIntervalMs(intervalMs: number): void {
		if (!Number.isFinite(intervalMs)) return;
		const next = Math.max(INTERVAL_POLLER_MIN_MS, Math.trunc(intervalMs));
		if (next === this.intervalMs) return;
		this.intervalMs = next;

		if (this.timer) {
			clearInterval(this.timer);
			this.timer = setInterval(() => {
				void this.tick();
			}, this.intervalMs);
		}
	}

	start(): void {
		if (this.timer || this.unsubscribe) return;

		if (typeof this.client.subscribe === "function") {
			this.usingSubscription = true;
			this.unsubscribe = this.client.subscribe(event => {
				this.handleStoreEvent(event);
			});

			void this.tick();
			return;
		}

		this.usingSubscription = false;
		void this.tick();
		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}

		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = null;
		}

		this.usingSubscription = false;
	}

	private updateIssuesSnapshot(issues: TaskIssue[]): void {
		const signature = readySignature(issues);
		if (this.lastIssuesSig === signature) return;
		this.lastIssuesSig = signature;
		this._issuesSnapshot = issues;
		this.emit("issues-changed", issues);
	}

	private updateReadySnapshot(ready: TaskIssue[]): void {
		const signature = readySignature(ready);
		if (this.lastReadySig === signature) return;
		this.lastReadySig = signature;
		this._readySnapshot = ready;
		this.emit("ready-changed", ready);
	}

	private handleStoreEvent(event: TaskStoreEvent): void {
		try {
			if (event.type === "issues-changed") {
				if (!this.includeIssueList) return;
				if (!Array.isArray(event.issues)) return;
				this.updateIssuesSnapshot(event.issues);
				return;
			}

			if (event.type === "ready-changed") {
				if (!Array.isArray(event.ready)) return;
				this.updateReadySnapshot(event.ready);
				return;
			}

			if (event.type === "activity") {
				if (!this.includeActivity) return;
				if (!Array.isArray(event.activity) || event.activity.length === 0) return;
				this.emit("activity", event.activity);
			}
		} catch (err) {
			this.emitErrorOnce(err);
		}
	}

	private rememberActivityKeys(keys: readonly string[]): void {
		for (const key of keys) {
			if (this.seenActivityKeys.has(key)) continue;
			this.seenActivityKeys.add(key);
			this.seenActivityOrder.push(key);
		}

		while (this.seenActivityOrder.length > this.maxSeenActivity) {
			const oldest = this.seenActivityOrder.shift();
			if (oldest) this.seenActivityKeys.delete(oldest);
		}
	}

	private emitErrorOnce(err: unknown): void {
		let signature: string;
		if (err instanceof Error) {
			signature = `${err.name}:${err.message}`;
		} else if (typeof err === "string") {
			signature = err;
		} else {
			try {
				signature = JSON.stringify(err);
			} catch {
				signature = String(err);
			}
		}

		if (this.lastErrorSig === signature) return;
		this.lastErrorSig = signature;
		this.emit("error", err);
	}

	private async tick(): Promise<void> {
		if (this.tickInFlight) return;
		this.tickInFlight = true;

		try {
			let ok = true;

			if (this.includeIssueList) {
				try {
					const issues = await this.client.list(["--all", "--limit", "0"]);
					this.updateIssuesSnapshot(issues);
				} catch (err) {
					ok = false;
					this.emitErrorOnce(err);
				}
			}

			try {
				const ready = await this.client.ready();
				this.updateReadySnapshot(ready);
			} catch (err) {
				ok = false;
				this.emitErrorOnce(err);
			}

			if (this.includeActivity && !this.usingSubscription) {
				try {
					const activity = await this.client.activity({ limit: this.activityLimit });
					const keys = activity.map(activityKey);

					if (!this.activityInitialized) {
						this.activityInitialized = true;
						this.rememberActivityKeys(keys);
					} else {
						const newEvents: TaskActivityEvent[] = [];
						const newKeys: string[] = [];

						for (let i = activity.length - 1; i >= 0; i -= 1) {
							const event = activity[i];
							if (!event) continue;
							const key = keys[i];
							if (!key || this.seenActivityKeys.has(key)) continue;
							newEvents.push(event);
							newKeys.push(key);
						}

						if (newEvents.length > 0) {
							this.rememberActivityKeys(newKeys);
							this.emit("activity", newEvents);
						}
					}
				} catch (err) {
					ok = false;
					this.emitErrorOnce(err);
				}
			}

			if (ok) this.lastErrorSig = null;
		} finally {
			this.tickInFlight = false;
		}
	}
}
