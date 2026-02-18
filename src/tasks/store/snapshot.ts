import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { TaskActivityEvent, TaskIssue } from "../types";
import {
	INDEX_FILENAME,
	STORE_FILENAME,
	type StoredAgentLog,
	type StoredDependency,
	type StoredIssue,
	type StoredUsage,
	type StoreSnapshot,
	type TaskIndexEntry,
} from "./types";
import {
	buildActivityEventId,
	clampPriority,
	compareIssueIds,
	createEmptyStore,
	normalizeComments,
	normalizeDependencies,
	normalizeDependsOnIds,
	normalizeLabels,
	normalizeString,
	normalizeToken,
	nowIso,
	toStoredUsage,
} from "./utilities";

const AGENT_LOG_FIELD = "__agent_log";
const ACTIVITY_FILENAME = "_activity.json";

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeTaskIndexEntry(id: string, raw: unknown): TaskIndexEntry | null {
	if (!id) return null;
	if (!isRecord(raw)) return null;
	const status = normalizeString(raw.status);
	if (!status) return null;
	const priority = clampPriority(
		typeof raw.priority === "number" ? raw.priority : raw.priority != null ? Number(raw.priority) : undefined,
	);
	const title = normalizeString(raw.title);
	if (!title) return null;
	const issueType = normalizeString(raw.issue_type);
	if (!issueType) return null;
	const labels = normalizeLabels(raw.labels);
	const updatedAt = normalizeString(raw.updated_at) ?? nowIso();
	const assignee = normalizeString(raw.assignee);
	return {
		status,
		priority,
		title,
		issue_type: issueType,
		labels,
		updated_at: updatedAt,
		...(assignee ? { assignee } : {}),
	};
}

function normalizeTaskIndex(raw: unknown): Record<string, TaskIndexEntry> {
	const out: Record<string, TaskIndexEntry> = {};
	if (!isRecord(raw)) return out;
	for (const [id, value] of Object.entries(raw)) {
		const entry = normalizeTaskIndexEntry(id, value);
		if (!entry) continue;
		out[id] = entry;
	}
	return out;
}

export function buildTaskIndexFromIssues(issues: Record<string, StoredIssue>): Record<string, TaskIndexEntry> {
	const index: Record<string, TaskIndexEntry> = {};
	for (const issue of Object.values(issues)) {
		const entry = toTaskIndexEntry(issue);
		if (!entry) continue;
		index[issue.id] = entry;
	}
	return index;
}

export function toTaskIndexEntry(issue: StoredIssue): TaskIndexEntry {
	return {
		status: normalizeToken(issue.status) || issue.status,
		priority: clampPriority(issue.priority),
		title: issue.title,
		issue_type: issue.issue_type,
		labels: [...issue.labels],
		updated_at: issue.updated_at,
		...(issue.assignee ? { assignee: issue.assignee } : {}),
	};
}

export function normalizeAgentLog(raw: unknown): StoredAgentLog | null {
	if (!isRecord(raw)) return null;
	const agentId = normalizeString(raw.agent_id);
	if (!agentId) return null;
	const usage =
		raw.usage && typeof raw.usage === "object" && !Array.isArray(raw.usage)
			? toStoredUsage(raw.usage as StoredUsage)
			: undefined;
	return {
		agent_id: agentId,
		task_id: normalizeString(raw.task_id) ?? null,
		updated_at: normalizeString(raw.updated_at) ?? nowIso(),
		usage: usage ?? {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		},
		messages: Array.isArray(raw.messages) ? raw.messages : [],
	};
}

export function loadTaskFile(
	tasksDir: string,
	issueId: string,
): Promise<{ issue: StoredIssue; agentLog?: StoredAgentLog } | null> {
	const filePath = path.join(tasksDir, `${issueId}.json`);
	return (async () => {
		let raw = "";
		try {
			raw = await fs.readFile(filePath, "utf8");
		} catch {
			return null;
		}
		if (!raw.trim()) return null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
		if (!isRecord(parsed)) return null;
		const issue = normalizeIssue({ ...parsed, id: normalizeString(parsed.id) ?? issueId });
		if (!issue) return null;
		const agentLogRaw = isRecord(parsed) ? parsed[AGENT_LOG_FIELD] : undefined;
		const log = normalizeAgentLog(agentLogRaw);
		return {
			issue,
			...(log ? { agentLog: { ...log, agent_id: issue.id } } : {}),
		};
	})();
}

export async function saveTaskFile(tasksDir: string, issue: StoredIssue, agentLog?: StoredAgentLog): Promise<void> {
	const filePath = path.join(tasksDir, `${issue.id}.json`);
	const payload = { ...issue } as Record<string, unknown>;
	if (agentLog) payload[AGENT_LOG_FIELD] = { ...agentLog };
	const text = `${JSON.stringify(payload, null, 2)}\n`;
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tempPath, text, "utf8");
	await fs.rename(tempPath, filePath);
}

export async function deleteTaskFile(tasksDir: string, issueId: string): Promise<void> {
	const filePath = path.join(tasksDir, `${issueId}.json`);
	try {
		await fs.unlink(filePath);
	} catch (err) {
		if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) {
			throw err;
		}
	}
}

export async function loadIndex(tasksDir: string): Promise<Record<string, TaskIndexEntry>> {
	const indexPath = path.join(tasksDir, INDEX_FILENAME);
	let raw = "";
	try {
		raw = await fs.readFile(indexPath, "utf8");
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {};
		throw err;
	}
	if (!raw.trim()) return {};
	try {
		return normalizeTaskIndex(JSON.parse(raw));
	} catch {
		return {};
	}
}

export async function saveIndex(tasksDir: string, index: Record<string, TaskIndexEntry>): Promise<void> {
	const indexPath = path.join(tasksDir, INDEX_FILENAME);
	const text = `${JSON.stringify(index, null, 2)}\n`;
	const tempPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tempPath, text, "utf8");
	await fs.rename(tempPath, indexPath);
}

export async function loadActivity(tasksDir: string): Promise<TaskActivityEvent[]> {
	const filePath = path.join(tasksDir, ACTIVITY_FILENAME);
	let raw = "";
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
		throw err;
	}
	if (!raw.trim()) return [];
	try {
		return normalizeActivity(JSON.parse(raw));
	} catch {
		return [];
	}
}

export async function saveActivity(tasksDir: string, activity: TaskActivityEvent[]): Promise<void> {
	const filePath = path.join(tasksDir, ACTIVITY_FILENAME);
	const text = `${JSON.stringify(activity, null, 2)}\n`;
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tempPath, text, "utf8");
	await fs.rename(tempPath, filePath);
}

export async function migrateMonolithicToPerFile(
	tasksDir: string,
	state: StoreSnapshot,
): Promise<Record<string, TaskIndexEntry>> {
	await Promise.all(
		Object.values(state.issues).map(issue => saveTaskFile(tasksDir, issue, state.agentLogs[issue.id])),
	);
	const index = buildTaskIndexFromIssues(state.issues);
	await saveIndex(tasksDir, index);
	await saveActivity(tasksDir, state.activity);
	const sourcePath = path.join(tasksDir, STORE_FILENAME);
	const backupPath = `${sourcePath}.migrated`;
	try {
		await fs.rename(sourcePath, backupPath);
	} catch (err) {
		if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) {
			throw err;
		}
	}
	return index;
}

export function normalizeIssue(raw: unknown): StoredIssue | null {
	if (!isRecord(raw)) return null;
	const id = normalizeString(raw.id);
	if (!id) return null;

	const createdAt = normalizeString(raw.created_at) ?? nowIso();
	const updatedAt = normalizeString(raw.updated_at) ?? createdAt;
	const comments = normalizeComments(raw.comments, id);
	const dependsOnIds = new Set<string>(normalizeDependsOnIds(raw.depends_on_ids));
	const dependencies = normalizeDependencies(raw.dependencies);
	const references = normalizeDependsOnIds(raw.references);
	for (const dependency of dependencies) {
		if (dependency.id) dependsOnIds.add(dependency.id);
	}
	const legacyDependsOn = raw.depends_on;
	if (Array.isArray(legacyDependsOn)) {
		for (const dependency of legacyDependsOn) {
			if (dependency && typeof dependency === "object") {
				const dep = dependency as Record<string, unknown>;
				const depId = normalizeString(dep.depends_on_id) ?? normalizeString(dep.id);
				if (depId) dependsOnIds.add(depId);
				continue;
			}
			const depId = normalizeString(dependency);
			if (depId) dependsOnIds.add(depId);
		}
	}

	const issueType = normalizeString(raw.issue_type) ?? "task";
	const status = normalizeString(raw.status) ?? (issueType === "agent" ? "spawning" : "open");
	const usageTotalsRec = raw.usage_totals;
	const usageTotals =
		usageTotalsRec && typeof usageTotalsRec === "object" && !Array.isArray(usageTotalsRec)
			? toStoredUsage(usageTotalsRec as StoredUsage)
			: undefined;

	const issue: StoredIssue = {
		id,
		title: normalizeString(raw.title) ?? id,
		description: normalizeString(raw.description),
		acceptance_criteria: normalizeString(raw.acceptance_criteria),
		status,
		priority: clampPriority(typeof raw.priority === "number" ? raw.priority : undefined),
		issue_type: issueType,
		labels: normalizeLabels(raw.labels),
		assignee: normalizeString(raw.assignee),
		created_at: createdAt,
		updated_at: updatedAt,
		comments,
		references,
		depends_on_ids: [...dependsOnIds],
		dependencies,
	};

	const hookTask = normalizeString(raw.hook_task);
	if (hookTask) issue.hook_task = hookTask;
	const agentState = normalizeString(raw.agent_state);
	if (agentState) issue.agent_state = agentState;
	const lastActivity = normalizeString(raw.last_activity);
	if (lastActivity) issue.last_activity = lastActivity;
	const closeReason = normalizeString(raw.close_reason);
	if (closeReason) issue.close_reason = closeReason;
	const closedAt = normalizeString(raw.closed_at);
	if (closedAt) issue.closed_at = closedAt;
	if (usageTotals) issue.usage_totals = usageTotals;
	if (raw.slot_bindings && isRecord(raw.slot_bindings)) {
		const bindings: Record<string, string> = {};
		for (const [slot, target] of Object.entries(raw.slot_bindings as Record<string, unknown>)) {
			if (!slot.trim()) continue;
			const taskId = normalizeString(target);
			if (!taskId) continue;
			bindings[slot] = taskId;
		}
		if (Object.keys(bindings).length > 0) issue.slot_bindings = bindings;
	}

	return issue;
}

export function normalizeActivity(raw: unknown): TaskActivityEvent[] {
	if (!Array.isArray(raw)) return [];
	const out: TaskActivityEvent[] = [];
	for (const item of raw) {
		if (!isRecord(item)) continue;
		out.push({
			...item,
			id: normalizeString(item.id) ?? buildActivityEventId(),
			issue_id: normalizeString(item.issue_id) ?? undefined,
			type: normalizeString(item.type) ?? "event",
			created_at: normalizeString(item.created_at) ?? nowIso(),
			updated_at: normalizeString(item.updated_at) ?? normalizeString(item.created_at) ?? nowIso(),
		});
	}
	return out;
}

export function normalizeAgentLogs(raw: unknown): Record<string, StoredAgentLog> {
	if (!isRecord(raw)) return {};
	const out: Record<string, StoredAgentLog> = {};
	for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
		const normalizedAgentId = normalizeString(agentId);
		if (!normalizedAgentId) continue;
		const normalized = normalizeAgentLog({ ...(value as Record<string, unknown>), agent_id: normalizedAgentId });
		if (!normalized) continue;
		out[normalizedAgentId] = normalized;
	}
	return out;
}

export function cloneIssue(issue: StoredIssue): StoredIssue {
	return {
		...issue,
		labels: [...issue.labels],
		comments: issue.comments.map(comment => ({ ...comment })),
		references: normalizeDependsOnIds(issue.references),
		depends_on_ids: [...issue.depends_on_ids],
		dependencies: issue.dependencies.map(dep => ({ ...dep })),
		slot_bindings: issue.slot_bindings ? { ...issue.slot_bindings } : undefined,
		usage_totals: issue.usage_totals ? { ...issue.usage_totals } : undefined,
	};
}

export function materializeIssue(issue: StoredIssue, state: StoreSnapshot): TaskIssue {
	const out = cloneIssue(issue);
	out.references = normalizeDependsOnIds(out.references);
	const dependencyIds = new Set<string>();
	for (const id of out.depends_on_ids) {
		if (id !== out.id) dependencyIds.add(id);
	}
	for (const dependency of out.dependencies) {
		const id = normalizeString(dependency.depends_on_id) ?? normalizeString(dependency.id);
		if (!id || id === out.id) continue;
		dependencyIds.add(id);
	}

	const dependencies: StoredDependency[] = [];
	for (const dependencyId of dependencyIds) {
		const existing = out.dependencies.find(dep => {
			const id = normalizeString(dep.depends_on_id) ?? normalizeString(dep.id);
			return id === dependencyId;
		});
		const target = state.issues[dependencyId];
		dependencies.push({
			...(existing ?? {}),
			id: dependencyId,
			depends_on_id: dependencyId,
			status: normalizeString(existing?.status) ?? normalizeString(target?.status) ?? undefined,
			type:
				normalizeString(existing?.type) ??
				normalizeString(existing?.dependency_type) ??
				normalizeString(existing?.type) ??
				"blocks",
			dependency_type:
				normalizeString(existing?.dependency_type) ??
				normalizeString(existing?.type) ??
				normalizeString(existing?.dependency_type) ??
				"blocks",
		});
	}

	dependencies.sort((a, b) => compareIssueIds(a.id, b.id));
	out.depends_on_ids = dependencies.map(dep => dep.id);
	out.depends_on = dependencies.map(dep => ({
		id: dep.id,
		depends_on_id: dep.id,
		status: dep.status,
		type: dep.type,
		dependency_type: dep.dependency_type,
	}));
	out.dependencies = dependencies;
	out.dependency_count = dependencies.length;
	out.comments.sort((a, b) => (a.id === b.id ? a.created_at.localeCompare(b.created_at) : a.id - b.id));
	return out;
}

export function listAllMaterialized(state: StoreSnapshot): TaskIssue[] {
	return Object.values(state.issues).map(issue => materializeIssue(issue, state));
}

export function parseStorePayload(raw: unknown): StoreSnapshot {
	const base = createEmptyStore();
	if (!isRecord(raw)) return base;
	const issuesRec = (raw as Record<string, unknown>).issues;
	if (issuesRec && isRecord(issuesRec)) {
		for (const [id, value] of Object.entries(issuesRec)) {
			const issue = normalizeIssue({ ...(value as Record<string, unknown>), id });
			if (!issue) continue;
			base.issues[issue.id] = issue;
		}
	}

	base.activity = normalizeActivity(raw.activity);
	base.agentLogs = normalizeAgentLogs((raw as Record<string, unknown>).agentLogs);

	const nextCommentId = Number((raw as Record<string, unknown>).nextCommentId);
	if (Number.isFinite(nextCommentId) && nextCommentId > 0) {
		base.nextCommentId = Math.trunc(nextCommentId);
	}
	for (const issue of Object.values(base.issues)) {
		for (const comment of issue.comments) {
			if (comment.id >= base.nextCommentId) {
				base.nextCommentId = Math.trunc(comment.id) + 1;
			}
		}
	}

	return base;
}

export async function loadLegacyIssueFiles(tasksDir: string): Promise<StoreSnapshot> {
	const snapshot = createEmptyStore();
	const entries = await fs.readdir(tasksDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(".json")) continue;
		if (entry.name === STORE_FILENAME || entry.name === INDEX_FILENAME) continue;
		const stem = entry.name.slice(0, -".json".length);
		const loaded = await loadTaskFile(tasksDir, stem);
		if (!loaded) continue;
		snapshot.issues[loaded.issue.id] = loaded.issue;
		if (loaded.agentLog) snapshot.agentLogs[loaded.issue.id] = loaded.agentLog;
		for (const comment of loaded.issue.comments) {
			if (comment.id >= snapshot.nextCommentId) {
				snapshot.nextCommentId = Math.trunc(comment.id) + 1;
			}
		}
	}
	return snapshot;
}
