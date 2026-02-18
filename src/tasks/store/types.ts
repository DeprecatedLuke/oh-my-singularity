import path from "node:path";
import {
	DELAY_DEFERRED_FLUSH_MS,
	LIMIT_ACTIVITY_DEFAULT,
	LIMIT_ACTIVITY_MAX_EVENTS,
	LIMIT_AGENT_ISSUES,
	LIMIT_AGENT_LOG_MESSAGES,
	LIMIT_AGENT_LOGS,
	TIMEOUT_STALE_AGENT_TTL_MS,
} from "../../config/constants";

import type { TaskCreateInput } from "../client";
import type { TaskActivityEvent, TaskComment, TaskIssue } from "../types";

export const STORE_FILENAME = "tasks.json";
export const INDEX_FILENAME = "_index.json";
export const STORE_VERSION = 1;
export const DEFAULT_ACTIVITY_LIMIT = LIMIT_ACTIVITY_DEFAULT;
export const MAX_ACTIVITY_EVENTS = LIMIT_ACTIVITY_MAX_EVENTS;
export const MAX_AGENT_LOG_MESSAGES = LIMIT_AGENT_LOG_MESSAGES;
export const MAX_AGENT_ISSUES = LIMIT_AGENT_ISSUES;
export const MAX_AGENT_LOGS = LIMIT_AGENT_LOGS;
export const STALE_AGENT_HEARTBEAT_TTL_MS = TIMEOUT_STALE_AGENT_TTL_MS;
export const DEFERRED_FLUSH_MS = DELAY_DEFERRED_FLUSH_MS;
export const AGENT_TERMINAL_STATES = new Set(["done", "failed", "aborted", "stopped", "dead", "closed"]);
export const VALID_TASK_STATUSES = new Set(["open", "in_progress", "blocked", "deferred", "closed"]);
export const VALID_AGENT_STATUSES = new Set([
	"spawning",
	"open",
	"in_progress",
	"blocked",
	"deferred",
	"closed",
	"done",
	"failed",
	"aborted",
	"stopped",
	"dead",
]);
export const DEFAULT_TYPES = [
	"task",
	"bug",
	"feature",
	"epic",
	"group",
	"noop",
	"chore",
	"agent",
	"role",
	"rig",
	"convoy",
	"event",
	"slot",
	"merge-request",
	"molecule",
	"gate",
] as const;
export type BatchCreateIssueInput = {
	key?: string;
	title: string;
	description?: string | null;
	priority?: number;
	depends_on?: string[];
} & TaskCreateInput;

export type BatchCreateResult = {
	issues: TaskIssue[];
	keyMap: Record<string, string>;
};

export type ParsedListArgs = {
	includeClosed: boolean;
	status: string | null;
	type: string | null;
	limit: number | null;
};

export type StoredUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

export type StoredDependency = {
	id: string;
	depends_on_id?: string;
	status?: string;
	type?: string;
	dependency_type?: string;
	created_at?: string;
	updated_at?: string;
	[key: string]: unknown;
};

export type StoredIssue = TaskIssue & {
	comments: TaskComment[];
	depends_on_ids: string[];
	dependencies: StoredDependency[];
	slot_bindings?: Record<string, string>;
	hook_task?: string | null;
	agent_state?: string | null;
	last_activity?: string | null;
	close_reason?: string | null;
	usage_totals?: StoredUsage;
};
export type TaskIndexEntry = {
	status: string;
	priority: number;
	title: string;
	issue_type: string;
	labels: string[];
	updated_at: string;
	scope?: string;
	assignee?: string | null;
};

export type StoredAgentLog = {
	agent_id: string;
	task_id: string | null;
	updated_at: string;
	usage: StoredUsage;
	messages: unknown[];
};

export type StoreSnapshot = {
	version: number;
	nextCommentId: number;
	issues: Record<string, StoredIssue>;
	activity: TaskActivityEvent[];
	agentLogs: Record<string, StoredAgentLog>;
};

export interface JsonTaskStoreOptions {
	cwd: string;
	sessionDir: string;
	actor?: string;
}

export function computeJsonTaskStoreDir(sessionDir: string): string {
	return path.join(sessionDir, "tasks");
}
