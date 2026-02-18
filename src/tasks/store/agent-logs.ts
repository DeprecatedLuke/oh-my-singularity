import { LIMIT_MESSAGE_HISTORY_DEFAULT } from "../../config/constants";
import {
	AGENT_TERMINAL_STATES,
	MAX_AGENT_ISSUES,
	MAX_AGENT_LOGS,
	STALE_AGENT_HEARTBEAT_TTL_MS,
	type StoredIssue,
	type StoreSnapshot,
} from "./types";
import {
	emptyUsage,
	normalizeString,
	normalizeToken,
	nowIso,
	parseTimestampMs,
	sanitizeIssueId,
	toStoredUsage,
} from "./utilities";

export type AgentUsageInput = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

export function compactAgentArtifacts(state: StoreSnapshot): boolean {
	let changed = false;
	const staleCutoffMs = Date.now() - STALE_AGENT_HEARTBEAT_TTL_MS;
	const parseIssueActivityMs = (issue: StoredIssue): number =>
		parseTimestampMs(issue.last_activity) ??
		parseTimestampMs(issue.updated_at) ??
		parseTimestampMs(issue.created_at) ??
		0;

	for (const issue of Object.values(state.issues)) {
		if (normalizeToken(issue.issue_type) !== "agent") continue;
		const status = normalizeToken(issue.status);
		const activityMs = parseIssueActivityMs(issue);
		if (!AGENT_TERMINAL_STATES.has(status) && activityMs > 0 && activityMs < staleCutoffMs) {
			issue.status = "dead";
			issue.agent_state = "dead";
			changed = true;
		}
	}

	const agentIssues = Object.values(state.issues).filter(issue => normalizeToken(issue.issue_type) === "agent");
	agentIssues.sort((a, b) => parseIssueActivityMs(b) - parseIssueActivityMs(a));
	const keepAgentIds = new Set(agentIssues.slice(0, MAX_AGENT_ISSUES).map(issue => issue.id));
	for (const issue of agentIssues) {
		if (keepAgentIds.has(issue.id)) continue;
		delete state.issues[issue.id];
		changed = true;
	}

	const remainingIssueIds = new Set(Object.keys(state.issues));
	for (const [agentId] of Object.entries(state.agentLogs)) {
		if (!remainingIssueIds.has(agentId)) {
			delete state.agentLogs[agentId];
			changed = true;
		}
	}

	for (const log of Object.values(state.agentLogs)) {
		const beforeCount = Array.isArray(log.messages) ? log.messages.length : 0;
		if (beforeCount > 0) {
			log.messages = [];
			changed = true;
		} else if (!Array.isArray(log.messages)) {
			log.messages = [];
			changed = true;
		}
	}

	const logs = Object.values(state.agentLogs);
	logs.sort((a, b) => (parseTimestampMs(b.updated_at) ?? 0) - (parseTimestampMs(a.updated_at) ?? 0));
	for (const log of logs.slice(MAX_AGENT_LOGS)) {
		delete state.agentLogs[log.agent_id];
		changed = true;
	}

	return changed;
}

export function ensureAgentIssue(state: StoreSnapshot, id: string, actor: string): StoredIssue {
	const normalizedId = sanitizeIssueId(id);
	const existing = state.issues[normalizedId];
	if (existing) return existing;
	const now = nowIso();
	const created: StoredIssue = {
		id: normalizedId,
		title: normalizedId,
		description: null,
		acceptance_criteria: null,
		status: "spawning",
		priority: 0,
		issue_type: "agent",
		labels: ["gt:agent"],
		assignee: actor,
		created_at: now,
		updated_at: now,
		comments: [],
		references: [],
		depends_on_ids: [],
		dependencies: [],
		agent_state: "spawning",
		last_activity: now,
	};
	state.issues[normalizedId] = created;
	return created;
}

export function setAgentState(state: StoreSnapshot, id: string, nextState: string, actor: string): StoredIssue {
	const issue = ensureAgentIssue(state, id, actor);
	const now = nowIso();
	issue.status = nextState;
	issue.agent_state = nextState;
	issue.last_activity = now;
	issue.updated_at = now;
	return issue;
}

export function heartbeatAgent(state: StoreSnapshot, id: string, actor: string): StoredIssue {
	const issue = ensureAgentIssue(state, id, actor);
	const now = nowIso();
	issue.last_activity = now;
	issue.updated_at = now;
	return issue;
}

export function setSlotBinding(
	state: StoreSnapshot,
	agentId: string,
	slot: string,
	taskId: string,
	actor: string,
): StoredIssue {
	const issue = ensureAgentIssue(state, agentId, actor);
	if (!issue.slot_bindings) issue.slot_bindings = {};
	issue.slot_bindings[slot] = taskId;
	if (slot === "hook") issue.hook_task = taskId;
	issue.updated_at = nowIso();

	const log = state.agentLogs[issue.id];
	if (log) {
		log.task_id = taskId;
		log.updated_at = issue.updated_at;
	}

	return issue;
}

export function clearSlotBinding(state: StoreSnapshot, agentId: string, slot: string, actor: string): StoredIssue {
	const issue = ensureAgentIssue(state, agentId, actor);
	if (issue.slot_bindings) {
		delete issue.slot_bindings[slot];
		if (Object.keys(issue.slot_bindings).length === 0) delete issue.slot_bindings;
	}
	if (slot === "hook") issue.hook_task = null;
	issue.updated_at = nowIso();
	return issue;
}

export function readAgentMessages(
	state: StoreSnapshot,
	agentId: string,
	limit = LIMIT_MESSAGE_HISTORY_DEFAULT,
): unknown[] {
	const normalizedId = sanitizeIssueId(agentId);
	if (!state.agentLogs[normalizedId]) return [];
	void limit;
	return [];
}

export function recordAgentEvent(
	state: StoreSnapshot,
	agentId: string,
	event: unknown,
	taskId: string | null | undefined,
	actor: string,
): { ok: true; dropped?: string } {
	const normalizedTaskId = normalizeString(taskId);
	const issue = ensureAgentIssue(state, agentId, actor);
	const normalizedAgentId = issue.id;
	let log = state.agentLogs[normalizedAgentId];
	if (!log) {
		log = {
			agent_id: normalizedAgentId,
			task_id: normalizedTaskId ?? normalizeString(issue.hook_task),
			updated_at: nowIso(),
			usage: emptyUsage(),
			messages: [],
		};
		state.agentLogs[normalizedAgentId] = log;
	}
	if (normalizedTaskId) log.task_id = normalizedTaskId;
	const eventRec =
		event && typeof event === "object" && !Array.isArray(event) ? (event as Record<string, unknown>) : null;
	const eventType = eventRec && typeof eventRec.type === "string" ? eventRec.type : "";
	if (eventType === "message_update") return { ok: true, dropped: eventType };
	const now = nowIso();
	log.updated_at = now;
	issue.last_activity = now;
	issue.updated_at = now;
	return { ok: true };
}

export function recordAgentUsage(
	state: StoreSnapshot,
	agentId: string,
	usage: AgentUsageInput,
	taskId: string | null | undefined,
	actor: string,
): { ok: true } {
	const normalizedTaskId = normalizeString(taskId);
	const normalizedUsage = toStoredUsage(usage);
	const issue = ensureAgentIssue(state, agentId, actor);
	const normalizedAgentId = issue.id;
	let log = state.agentLogs[normalizedAgentId];
	if (!log) {
		log = {
			agent_id: normalizedAgentId,
			task_id: normalizedTaskId ?? normalizeString(issue.hook_task),
			updated_at: nowIso(),
			usage: emptyUsage(),
			messages: [],
		};
		state.agentLogs[normalizedAgentId] = log;
	}
	if (normalizedTaskId) log.task_id = normalizedTaskId;
	log.usage = normalizedUsage;
	log.updated_at = nowIso();
	issue.usage_totals = normalizedUsage;
	issue.updated_at = log.updated_at;

	const aggregateTaskId = normalizedTaskId ?? normalizeString(log.task_id) ?? normalizeString(issue.hook_task);
	if (aggregateTaskId) {
		const aggregateIssue = state.issues[aggregateTaskId];
		if (aggregateIssue) {
			const sum = emptyUsage();
			for (const candidateLog of Object.values(state.agentLogs)) {
				if (candidateLog.task_id !== aggregateTaskId) continue;
				sum.input += candidateLog.usage.input;
				sum.output += candidateLog.usage.output;
				sum.cacheRead += candidateLog.usage.cacheRead;
				sum.cacheWrite += candidateLog.usage.cacheWrite;
				sum.totalTokens += candidateLog.usage.totalTokens;
				sum.cost += candidateLog.usage.cost;
			}
			aggregateIssue.usage_totals = sum;
			aggregateIssue.updated_at = nowIso();
		}
	}

	return { ok: true };
}
