import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
	TaskCreateInput,
	TaskDepTreeInput,
	TaskSearchInput,
	TaskStoreClient,
	TaskStoreEvent,
	TaskUpdateInput,
} from "../client";
import type { TaskActivityEvent, TaskComment, TaskIssue } from "../types";
import { getActivity, pushActivity } from "./activity";
import {
	clearSlotBinding,
	compactAgentArtifacts,
	heartbeatAgent,
	readAgentMessages,
	recordAgentEvent,
	recordAgentUsage,
	setAgentState,
	setSlotBinding,
} from "./agent-logs";
import {
	addCommentToIssue,
	addDependency,
	addLabelToIssue,
	closeIssue,
	createIssue,
	createIssueBatch,
	deleteIssue,
	requireIssue,
	updateIssue,
} from "./core";
import { buildDependencyTree, filterList, queryIssues, searchIssues } from "./search";
import {
	buildTaskIndexFromIssues,
	deleteTaskFile,
	listAllMaterialized,
	loadActivity,
	loadIndex,
	loadLegacyIssueFiles,
	materializeIssue,
	migrateMonolithicToPerFile,
	parseStorePayload,
	saveActivity,
	saveIndex,
	saveTaskFile,
	toTaskIndexEntry,
} from "./snapshot";
import {
	type BatchCreateIssueInput,
	type BatchCreateResult,
	computeJsonTaskStoreDir,
	DEFAULT_TYPES,
	DEFERRED_FLUSH_MS,
	type JsonTaskStoreOptions,
	STORE_FILENAME,
	type StoredIssue,
	type StoreSnapshot,
	type TaskIndexEntry,
} from "./types";
import { createEmptyStore, normalizeToken, parseListArgs, sanitizeIssueId } from "./utilities";

export { computeJsonTaskStoreDir };
export type { JsonTaskStoreOptions };

export class JsonTaskStore implements TaskStoreClient {
	private readonly cwd: string;
	private readonly actor: string;
	private readonly tasksDir: string;
	private readonly storeFilePath: string;
	private readonly events = new EventEmitter();

	private loaded = false;
	private loadPromise: Promise<void> | null = null;
	private mutationChain: Promise<void> = Promise.resolve();
	private state: StoreSnapshot = createEmptyStore();
	private index: Record<string, TaskIndexEntry> = {};
	private deferredFlushTimer: Timer | null = null;

	constructor(options: JsonTaskStoreOptions) {
		this.cwd = options.cwd;
		this.actor = options.actor ?? process.env.TASKS_ACTOR ?? "oh-my-singularity";
		this.tasksDir = computeJsonTaskStoreDir(options.sessionDir);
		this.storeFilePath = path.join(this.tasksDir, STORE_FILENAME);
	}

	get workingDir(): string {
		return this.cwd;
	}

	get tasksDirPath(): string {
		return this.tasksDir;
	}

	subscribe(listener: (event: TaskStoreEvent) => void): () => void {
		const wrapped = (event: TaskStoreEvent) => {
			listener(event);
		};
		this.events.on("event", wrapped);
		return () => {
			this.events.off("event", wrapped);
		};
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		if (this.loadPromise) return await this.loadPromise;
		this.loadPromise = this.load();
		await this.loadPromise;
		this.loadPromise = null;
	}

	private async load(): Promise<void> {
		await fs.mkdir(this.tasksDir, { recursive: true });

		let rawStoreText: string | null = null;
		try {
			rawStoreText = await fs.readFile(this.storeFilePath, "utf8");
		} catch (err) {
			if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) {
				throw err;
			}
		}

		if (rawStoreText?.trim()) {
			this.state = parseStorePayload(JSON.parse(rawStoreText));
			compactAgentArtifacts(this.state);
			this.index = await migrateMonolithicToPerFile(this.tasksDir, this.state);
			this.state.activity = await loadActivity(this.tasksDir);
			this.loaded = true;
			return;
		}

		this.state = await loadLegacyIssueFiles(this.tasksDir);
		this.index = await loadIndex(this.tasksDir);
		if (Object.keys(this.index).length === 0) {
			this.index = buildTaskIndexFromIssues(this.state.issues);
		}
		this.state.activity = await loadActivity(this.tasksDir);
		compactAgentArtifacts(this.state);
		this.loaded = true;
	}

	private async flush(): Promise<void> {
		await Promise.all([saveIndex(this.tasksDir, this.index), saveActivity(this.tasksDir, this.state.activity)]);
	}

	private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
		const run = this.mutationChain.then(work, work);
		this.mutationChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private cancelDeferredFlush(): void {
		if (!this.deferredFlushTimer) return;
		clearTimeout(this.deferredFlushTimer);
		this.deferredFlushTimer = null;
	}

	private scheduleDeferredFlush(): void {
		if (this.deferredFlushTimer) return;
		this.deferredFlushTimer = setTimeout(() => {
			this.deferredFlushTimer = null;
			void this.enqueueMutation(async () => {
				compactAgentArtifacts(this.state);
				await this.flush();
			});
		}, DEFERRED_FLUSH_MS);

		const timer = this.deferredFlushTimer as Timer;
		if (typeof timer.unref === "function") timer.unref();
	}

	private requireIssue(id: string): StoredIssue {
		return requireIssue(this.state, id);
	}

	private materializeIssue(issue: StoredIssue): TaskIssue {
		return materializeIssue(issue, this.state);
	}

	private listAllMaterialized(): TaskIssue[] {
		return listAllMaterialized(this.state);
	}

	private async mutate<T>(
		issueId: string | null,
		action: string,
		work: () => Promise<T>,
		opts?: { activityData?: Record<string, unknown>; skipActivity?: boolean },
	): Promise<T> {
		await this.ensureLoaded();
		return await this.enqueueMutation(async () => {
			const result = await work();
			let activity: TaskActivityEvent | undefined;
			const resultRecord =
				result !== null && typeof result === "object" && !Array.isArray(result)
					? (result as Record<string, unknown>)
					: null;
			const persistedIssueIds = new Set<string>();

			if (resultRecord && resultRecord.deleted === true && typeof resultRecord.id === "string") {
				await deleteTaskFile(this.tasksDir, resultRecord.id);
				delete this.index[resultRecord.id];
			} else {
				if (resultRecord && typeof resultRecord.issue_id === "string") {
					persistedIssueIds.add(resultRecord.issue_id);
				} else if (resultRecord && typeof resultRecord.id === "string") {
					persistedIssueIds.add(resultRecord.id);
				} else if (issueId) {
					persistedIssueIds.add(issueId);
				}
				if (resultRecord && Array.isArray(resultRecord.issues)) {
					for (const candidate of resultRecord.issues) {
						if (candidate && typeof candidate === "object") {
							const candidateId =
								typeof (candidate as { id?: unknown }).id === "string" ? (candidate as { id: string }).id : "";
							if (candidateId) {
								persistedIssueIds.add(candidateId);
							}
						}
					}
				}
				if (action === "agent_usage") {
					const aggregateTaskId = issueId
						? (this.state.agentLogs[issueId]?.task_id ?? this.state.issues[issueId]?.hook_task)
						: null;
					if (typeof aggregateTaskId === "string") persistedIssueIds.add(aggregateTaskId);
				}
			}

			for (const persistedIssueId of persistedIssueIds) {
				const issue = this.state.issues[persistedIssueId];
				if (!issue) continue;
				await saveTaskFile(this.tasksDir, issue, this.state.agentLogs[issue.id]);
				this.index[issue.id] = toTaskIndexEntry(issue);
			}
			if (!opts?.skipActivity) {
				activity = pushActivity(
					this.state,
					{
						type: action,
						issue_id: issueId ?? undefined,
						action,
						data: opts?.activityData,
					},
					this.actor,
				);
			}
			if (opts?.skipActivity) {
				this.scheduleDeferredFlush();
				return result;
			}
			this.cancelDeferredFlush();
			compactAgentArtifacts(this.state);
			await this.flush();
			this.emitChange(activity);
			return result;
		});
	}

	private emitChange(activity?: TaskActivityEvent): void {
		const issues = filterList(this.listAllMaterialized(), {
			includeClosed: true,
			status: null,
			type: null,
			limit: null,
		});
		const ready = issues.filter(
			issue => normalizeToken(issue.issue_type) === "task" && normalizeToken(issue.status) === "open",
		);
		this.events.emit("event", { type: "issues-changed", issues } satisfies TaskStoreEvent);
		this.events.emit("event", { type: "ready-changed", ready } satisfies TaskStoreEvent);
		if (activity) {
			this.events.emit("event", { type: "activity", activity: [activity] } satisfies TaskStoreEvent);
		}
	}

	async ready(): Promise<TaskIssue[]> {
		await this.ensureLoaded();
		return filterList(this.listAllMaterialized(), {
			includeClosed: true,
			status: "open",
			type: "task",
			limit: null,
		});
	}

	async list(args?: readonly string[]): Promise<TaskIssue[]> {
		await this.ensureLoaded();
		const parsed = parseListArgs(args);
		return filterList(this.listAllMaterialized(), parsed);
	}

	async show(id: string): Promise<TaskIssue> {
		await this.ensureLoaded();
		return this.materializeIssue(this.requireIssue(id));
	}

	async create(
		title: string,
		description?: string | null,
		priority?: number,
		options?: TaskCreateInput,
	): Promise<TaskIssue> {
		const normalizedTitle = title.trim();
		if (!normalizedTitle) throw new Error("create requires non-empty title");
		return await this.mutate(
			null,
			"create",
			async () =>
				this.materializeIssue(createIssue(this.state, this.actor, normalizedTitle, description, priority, options)),
			{ activityData: { issueType: options?.type ?? "task" } },
		);
	}
	async createBatch(inputs: BatchCreateIssueInput[]): Promise<BatchCreateResult> {
		return await this.mutate(null, "create_batch", async () => createIssueBatch(this.state, this.actor, inputs), {
			activityData: { batchSize: inputs.length },
		});
	}

	async update(id: string, patch: TaskUpdateInput): Promise<unknown> {
		return await this.mutate(
			id,
			"update",
			async () => this.materializeIssue(updateIssue(this.state, this.actor, id, patch)),
			{ activityData: { patch } },
		);
	}

	async close(id: string, reason?: string): Promise<unknown> {
		const result = await this.mutate<{ issue: TaskIssue; issues: TaskIssue[] }>(
			id,
			"close",
			async () => {
				const closedIssue = closeIssue(this.state, this.actor, id, reason);
				const affectedIssueIds = new Set<string>([closedIssue.id]);
				for (const candidate of Object.values(this.state.issues)) {
					const hasClosedDependency = candidate.dependencies.some(
						dependency => dependency.id === closedIssue.id || dependency.depends_on_id === closedIssue.id,
					);
					if (hasClosedDependency) affectedIssueIds.add(candidate.id);
				}
				return {
					issue: this.materializeIssue(closedIssue),
					issues: [...affectedIssueIds].map(issueId => this.materializeIssue(this.requireIssue(issueId))),
				};
			},
			{ activityData: { reason: reason ?? null } },
		);
		return result.issue;
	}

	async search(query: string, options?: TaskSearchInput): Promise<TaskIssue[]> {
		await this.ensureLoaded();
		return searchIssues(this.listAllMaterialized(), query, options);
	}

	async claim(id: string): Promise<unknown> {
		return await this.update(id, { claim: true, status: "in_progress" });
	}

	async updateStatus(id: string, status: string): Promise<unknown> {
		return await this.update(id, { status });
	}

	async addLabel(id: string, label: string): Promise<unknown> {
		const normalizedLabel = label.trim();
		if (!normalizedLabel) return null;
		return await this.mutate(
			id,
			"label_add",
			async () => this.materializeIssue(addLabelToIssue(this.state, id, normalizedLabel)),
			{ activityData: { label: normalizedLabel } },
		);
	}

	async comment(id: string, text: string): Promise<unknown> {
		const normalizedText = text.trim();
		if (!normalizedText) return null;
		return await this.mutate(
			id,
			"comment_add",
			async () => addCommentToIssue(this.state, this.actor, id, normalizedText),
			{ activityData: { text: normalizedText } },
		);
	}

	async comments(id: string): Promise<TaskComment[]> {
		await this.ensureLoaded();
		return this.requireIssue(id).comments.map(comment => ({ ...comment }));
	}

	async createAgent(name: string): Promise<string> {
		const issue = await this.create(name.trim() || "agent", null, 0, {
			type: "agent",
			labels: ["gt:agent"],
			assignee: this.actor,
		});
		return issue.id;
	}

	async setAgentState(id: string, state: string): Promise<unknown> {
		const normalizedState = state.trim();
		if (!normalizedState) return null;
		await this.ensureLoaded();

		const normalizedId = sanitizeIssueId(id);
		const existing = this.state.issues[normalizedId];
		const normalizedStateToken = normalizeToken(normalizedState);
		if (
			existing &&
			normalizeToken(existing.status) === normalizedStateToken &&
			normalizeToken(existing.agent_state) === normalizedStateToken
		) {
			return this.materializeIssue(existing);
		}
		return await this.mutate(
			normalizedId,
			"agent_state",
			async () => this.materializeIssue(setAgentState(this.state, normalizedId, normalizedState, this.actor)),
			{ activityData: { state: normalizedState } },
		);
	}

	async heartbeat(id: string): Promise<unknown> {
		return await this.mutate(
			id,
			"agent_heartbeat",
			async () => this.materializeIssue(heartbeatAgent(this.state, id, this.actor)),
			{ skipActivity: true },
		);
	}

	async setSlot(agentId: string, slot: string, taskId: string): Promise<unknown> {
		const normalizedSlot = slot.trim();
		const normalizedTaskId = taskId.trim();
		if (!normalizedSlot || !normalizedTaskId) return null;
		return await this.mutate(
			agentId,
			"slot_set",
			async () =>
				this.materializeIssue(setSlotBinding(this.state, agentId, normalizedSlot, normalizedTaskId, this.actor)),
			{ activityData: { slot: normalizedSlot, taskId: normalizedTaskId } },
		);
	}

	async clearSlot(agentId: string, slot: string): Promise<unknown> {
		const normalizedSlot = slot.trim();
		if (!normalizedSlot) return null;
		return await this.mutate(
			agentId,
			"slot_clear",
			async () => this.materializeIssue(clearSlotBinding(this.state, agentId, normalizedSlot, this.actor)),
			{ activityData: { slot: normalizedSlot } },
		);
	}

	async query(expr: string, args?: readonly string[]): Promise<TaskIssue[]> {
		await this.ensureLoaded();
		return queryIssues(this.listAllMaterialized(), expr, parseListArgs(args));
	}

	async depTree(id: string, options?: TaskDepTreeInput): Promise<unknown> {
		await this.ensureLoaded();
		return buildDependencyTree(this.state, this.requireIssue(id).id, options);
	}

	async depAdd(issueId: string, dependsOnId: string): Promise<unknown> {
		return await this.mutate(
			issueId,
			"dep_add",
			async () => this.materializeIssue(addDependency(this.state, issueId, dependsOnId)),
			{ activityData: { dependsOn: dependsOnId } },
		);
	}

	async types(): Promise<string[]> {
		return [...DEFAULT_TYPES];
	}

	async delete(id: string): Promise<unknown> {
		return await this.mutate(id, "delete", async () => deleteIssue(this.state, id));
	}

	async activity(options?: { limit?: number }): Promise<TaskActivityEvent[]> {
		await this.ensureLoaded();
		return getActivity(this.state, options?.limit);
	}

	async readAgentMessages(agentId: string, limit = 40): Promise<unknown[]> {
		await this.ensureLoaded();
		return readAgentMessages(this.state, agentId, limit);
	}

	async recordAgentEvent(agentId: string, event: unknown, taskId?: string | null): Promise<unknown> {
		return await this.mutate(
			agentId,
			"agent_event",
			async () => recordAgentEvent(this.state, agentId, event, taskId, this.actor),
			{ skipActivity: true },
		);
	}

	async recordAgentUsage(
		agentId: string,
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: number;
		},
		taskId?: string | null,
	): Promise<unknown> {
		return await this.mutate(
			agentId,
			"agent_usage",
			async () => recordAgentUsage(this.state, agentId, usage, taskId, this.actor),
			{ skipActivity: true },
		);
	}
}
