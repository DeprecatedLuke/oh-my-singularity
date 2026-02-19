import { UI_RESULT_MAX_LINES } from "../../config/constants";
import type { TaskComment, TaskIssue } from "../../tasks/types";
import { asRecord, clipText, previewValue, squashWhitespace } from "../../utils";
import { BG, BOLD, BOX, clipAnsi, FG, ICON, RESET, RESET_FG, UNBOLD, visibleWidth } from "../colors";
import { formatIssuePriority, formatIssueStatusStyled } from "../utils/task-issue-format";
import { sanitizeRenderableText, tryFormatJson, wrapLine } from "./text-formatter";

export type ToolBlock = {
	kind: "tool";
	toolName: string;
	argsPreview: string;
	/** Raw tool arguments (for structured result rendering). */
	argsData?: unknown;
	resultPreview: string;
	/** Full text content extracted from result.content — used for rich rendering. */
	resultContent: string;
	/** Raw tool result object (for structured result rendering). */
	resultData?: unknown;
	state: "pending" | "success" | "error";
	/** False while tool-call args are still streaming. */
	argsComplete: boolean;
};

const CAP_LEN = 3;
export const RESULT_MAX_LINES = UI_RESULT_MAX_LINES;

/** Extract text content from an AgentToolResult-shaped object (result.content[].text). */
export function extractResultText(result: unknown): string {
	const rec = asRecord(result);
	if (!rec) {
		if (typeof result !== "string") return "";
		const normalized = sanitizeRenderableText(result);
		if (!normalized.trim()) return "";
		return sanitizeRenderableText(tryFormatJson(normalized) ?? normalized);
	}
	const content = Array.isArray(rec.content) ? rec.content : [];
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			const normalized = sanitizeRenderableText(item);
			if (normalized.trim()) parts.push(normalized);
			continue;
		}
		const r = asRecord(item);
		if (!r) continue;
		if (typeof r.text === "string") {
			const normalized = sanitizeRenderableText(tryFormatJson(r.text) ?? r.text);
			if (normalized.trim()) parts.push(normalized);
			continue;
		}
		if (typeof r.content === "string") {
			const normalized = sanitizeRenderableText(tryFormatJson(r.content) ?? r.content);
			if (normalized.trim()) parts.push(normalized);
		}
	}
	const joined = parts.join("\n");
	return joined.trim() ? joined : "";
}

type ToolResultPreviewOptions = {
	toolName?: string;
	args?: unknown;
	isError?: boolean;
};

function getToolBaseName(toolName: string | undefined): string {
	return typeof toolName === "string" ? toolName.replace(/^proxy_/, "") : "";
}

export function getTasksAction(result: unknown, args: unknown): string {
	const argsRec = asRecord(args);
	if (argsRec && typeof argsRec.action === "string" && argsRec.action.trim()) return argsRec.action.trim();
	const resultRec = asRecord(result);
	if (resultRec && typeof resultRec.action === "string" && resultRec.action.trim()) return resultRec.action.trim();
	const detailsRec = asRecord(resultRec?.details);
	if (detailsRec && typeof detailsRec.action === "string" && detailsRec.action.trim()) return detailsRec.action.trim();
	const text = extractResultText(result);
	const match = text.match(/\btasks\s+([a-z_]+)\s*:/i);
	return match?.[1]?.trim() ?? "";
}

export function extractToolPayload(value: unknown): { record: Record<string, unknown> | null; payload: unknown } {
	const record = asRecord(value);
	if (!record) return { record: null, payload: value };
	if ("details" in record) return { record, payload: record.details };
	if ("data" in record) return { record, payload: record.data };
	return { record, payload: value };
}

export const TASK_LIST_ACTIONS = new Set(["list", "search", "ready", "query"]);
export const TASK_SINGLE_ACTIONS = new Set(["show", "create", "update", "close"]);

const TASK_STREAMING_ARG_ORDER = [
	"action",
	"id",
	"title",
	"description",
	"text",
	"priority",
	"labels",
	"depends_on",
	"references",
	"assignee",
	"status",
	"type",
	"includeClosed",
	"newStatus",
	"reason",
	"claim",
	"dependsOn",
	"query",
	"direction",
	"maxDepth",
	"limit",
] as const;
const TASK_STREAMING_ARG_KEYS = new Set<string>(TASK_STREAMING_ARG_ORDER);

function formatTaskStreamingFieldValue(value: unknown): string {
	if (typeof value === "string") return sanitizeRenderableText(value).trim();
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	if (Array.isArray(value)) {
		const parts = value
			.map(item => {
				if (typeof item === "string") return sanitizeInline(item);
				if (typeof item === "number" || typeof item === "boolean" || item === null) return String(item);
				return sanitizeInline(previewValue(item, 120));
			})
			.filter(Boolean);
		return parts.length > 0 ? parts.join(", ") : "[]";
	}
	return sanitizeInline(previewValue(value, 160));
}

function formatPendingTasksCallArgs(args: unknown, width: number): string[] | null {
	const rec = asRecord(args);
	if (!rec) return null;
	const keys = Object.keys(rec).filter(key => rec[key] !== undefined);
	if (keys.length === 0) return null;
	const orderedKeys = [
		...TASK_STREAMING_ARG_ORDER.filter(key => key in rec && rec[key] !== undefined),
		...keys.filter(key => !TASK_STREAMING_ARG_KEYS.has(key)).sort((a, b) => a.localeCompare(b)),
	];
	const lines: string[] = [];
	const boundedWidth = Math.max(1, width);
	for (const key of orderedKeys) {
		const value = formatTaskStreamingFieldValue(rec[key]);
		if (!value) continue;
		const label = `${key}: `;
		const indent = " ".repeat(label.length);
		let wroteLine = false;
		for (const valueLine of value.split(/\r?\n/)) {
			const wrapped = wrapLine(valueLine, Math.max(1, boundedWidth - label.length));
			if (wrapped.length === 0) {
				if (!wroteLine) {
					lines.push(clipText(label.trimEnd(), boundedWidth));
					wroteLine = true;
				}
				continue;
			}
			for (const part of wrapped) {
				if (!wroteLine) {
					lines.push(clipText(`${label}${part}`, boundedWidth));
					wroteLine = true;
				} else {
					lines.push(clipText(`${indent}${part}`, boundedWidth));
				}
			}
		}
	}
	return lines.length > 0 ? lines : null;
}

export function normalizeTaskAction(action: string): string {
	return action.trim().toLowerCase();
}

function sanitizeInline(value: unknown, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	const normalized = squashWhitespace(sanitizeRenderableText(value));
	return normalized || fallback;
}

function sanitizeMultiline(value: unknown): string {
	if (typeof value !== "string") return "";
	return sanitizeRenderableText(value).trim();
}

function isTaskIssueLike(value: unknown): value is TaskIssue {
	const rec = asRecord(value);
	return !!rec && typeof rec.id === "string" && typeof rec.title === "string";
}

function isTaskCommentLike(value: unknown): value is TaskComment {
	const rec = asRecord(value);
	return !!rec && typeof rec.issue_id === "string" && typeof rec.author === "string" && typeof rec.text === "string";
}

function normalizeTaskIssueArray(value: unknown): TaskIssue[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length === 0) return [];
	const out: TaskIssue[] = [];
	for (const item of value) {
		if (!isTaskIssueLike(item)) return null;
		out.push(item);
	}
	return out;
}

function normalizeTaskCommentArray(value: unknown): TaskComment[] | null {
	if (!Array.isArray(value)) return null;
	if (value.length === 0) return [];
	const out: TaskComment[] = [];
	for (const item of value) {
		if (!isTaskCommentLike(item)) return null;
		out.push(item);
	}
	return out;
}

export function extractTaskIssuePayload(payload: unknown): TaskIssue[] | null {
	const direct = normalizeTaskIssueArray(payload);
	if (direct) return direct;
	if (direct === null && Array.isArray(payload)) return null;
	const rec = asRecord(payload);
	if (!rec) return null;
	if (isTaskIssueLike(rec)) return [rec];
	const nested =
		normalizeTaskIssueArray(rec.tasks) ??
		normalizeTaskIssueArray(rec.issues) ??
		normalizeTaskIssueArray(rec.results) ??
		normalizeTaskIssueArray(rec.items);
	if (nested) return nested;
	if (nested === null && (Array.isArray(rec.tasks) || Array.isArray(rec.issues) || Array.isArray(rec.results))) {
		return null;
	}
	return null;
}

export function extractTaskCommentPayload(payload: unknown): TaskComment[] | null {
	const direct = normalizeTaskCommentArray(payload);
	if (direct) return direct;
	if (direct === null && Array.isArray(payload)) return null;
	const rec = asRecord(payload);
	if (!rec) return null;
	if (isTaskCommentLike(rec)) return [rec];
	const nested = normalizeTaskCommentArray(rec.comments) ?? normalizeTaskCommentArray(rec.items);
	if (nested) return nested;
	if (nested === null && (Array.isArray(rec.comments) || Array.isArray(rec.items))) return null;
	return null;
}

function extractTaskIdList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string") {
			const normalized = sanitizeInline(item);
			if (normalized) out.push(normalized);
			continue;
		}
		const rec = asRecord(item);
		if (!rec || typeof rec.id !== "string") continue;
		const normalized = sanitizeInline(rec.id);
		if (normalized) out.push(normalized);
	}
	return out;
}

function formatTaskDependencies(issue: TaskIssue): string {
	const rec = asRecord(issue);
	if (!rec) return "none";
	const dependencyIds = extractTaskIdList(rec.depends_on_ids);
	if (dependencyIds.length > 0) return dependencyIds.join(", ");
	const dependsOnIds = extractTaskIdList(rec.depends_on);
	if (dependsOnIds.length > 0) return dependsOnIds.join(", ");
	const dependsOn = sanitizeInline(rec.depends_on);
	if (dependsOn) return dependsOn;
	const dependencyCount = rec.dependency_count;
	if (typeof dependencyCount === "number" && Number.isFinite(dependencyCount) && dependencyCount > 0) {
		return String(Math.trunc(dependencyCount));
	}
	return "none";
}

function formatTaskReferences(issue: TaskIssue): string {
	const rec = asRecord(issue);
	if (!rec) return "none";
	const references = extractTaskIdList(rec.references);
	if (references.length > 0) return references.join(", ");
	const rawReferences = sanitizeInline(rec.references);
	if (rawReferences) return rawReferences;
	return "none";
}

function padAnsi(text: string, width: number): string {
	const clipped = clipAnsi(text, width);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	return `${clipped}${padding}`;
}

function makeIndentedRow(width: number, text: string): string {
	const safeWidth = Math.max(1, width);
	const innerWidth = Math.max(1, safeWidth - 2);
	return `  ${padAnsi(text, innerWidth)}`;
}
function formatTruncatedMultiline(text: string, width: number, maxLines: number): string[] {
	const wrapped = wrapLine(text, width);
	if (wrapped.length <= maxLines) return wrapped.length > 0 ? wrapped : [""];
	const truncated = wrapped.slice(0, maxLines);
	const tail = truncated[maxLines - 1] ?? "";
	truncated[maxLines - 1] = clipText(`${tail}…`, width);
	return truncated;
}

export function buildIssueCardLines(issue: TaskIssue, width: number, action = "task"): string[] {
	if (width < 12) {
		const id = sanitizeInline(issue.id, "(unknown)");
		const title = sanitizeInline(issue.title, "(untitled)");
		return [`${id} ${title}`];
	}
	const textWidth = Math.max(1, width - 2);
	const rec = asRecord(issue);
	const taskId = sanitizeInline(issue.id, "(unknown)");
	const priority = formatIssuePriority(rec?.priority);
	const status = formatIssueStatusStyled(rec?.status);
	const issueType = sanitizeInline(rec?.issue_type);
	const deps = sanitizeInline(formatTaskDependencies(issue), "none");
	const refs = sanitizeInline(formatTaskReferences(issue), "none");
	const title = sanitizeInline(issue.title, "(untitled)");
	const description = sanitizeMultiline(rec?.description);
	const detailText = description || title;
	const detailLines = formatTruncatedMultiline(detailText, textWidth, 2);
	const typeSegment = issueType ? ` ${FG.dim}(${issueType})${RESET}` : "";
	const metaLine = `status: ${status}${typeSegment}  deps:${FG.dim}${deps}${RESET} refs:${FG.dim}${refs}${RESET}`;
	const actionLabel = sanitizeInline(action, "task");
	return [
		`${FG.accent}${actionLabel} (1)${RESET}`,
		makeIndentedRow(width, `task: ${taskId}  P:${priority}`),
		makeIndentedRow(width, metaLine),
		...detailLines.map(line => makeIndentedRow(width, line)),
	].slice(0, RESULT_MAX_LINES);
}
export function buildIssueTableLines(action: string, issues: readonly TaskIssue[], width: number): string[] {
	if (width < 12) {
		if (issues.length === 0) return ["(no tasks)"];
		return issues
			.slice(0, RESULT_MAX_LINES)
			.map(issue => `${sanitizeInline(issue.id, "(unknown)")} ${sanitizeInline(issue.title, "")}`);
	}
	const rows: string[] = [];
	const rowBudget = Math.max(1, RESULT_MAX_LINES - 2);
	if (issues.length === 0) {
		rows.push(makeIndentedRow(width, `${FG.dim}(no tasks)${RESET}`));
	} else {
		const visibleCount = issues.length > rowBudget ? Math.max(0, rowBudget - 1) : issues.length;
		for (const issue of issues.slice(0, visibleCount)) {
			const rec = asRecord(issue);
			const id = sanitizeInline(issue.id, "(unknown)");
			const status = formatIssueStatusStyled(rec?.status);
			const priority = formatIssuePriority(rec?.priority);
			const deps = sanitizeInline(formatTaskDependencies(issue), "none");
			const title = sanitizeInline(issue.title, "(untitled)");
			rows.push(
				makeIndentedRow(
					width,
					`${id}  ${status}  P:${priority}  D:${FG.dim}${deps}${RESET}  ${FG.muted}${title}${RESET}`,
				),
			);
		}
		if (issues.length > visibleCount) {
			const remaining = issues.length - visibleCount;
			rows.push(makeIndentedRow(width, `${FG.dim}… ${remaining} more task${remaining === 1 ? "" : "s"}${RESET}`));
		}
	}
	const label = action ? `${action} (${issues.length})` : `tasks (${issues.length})`;
	return [`${FG.accent}${label}${RESET}`, ...rows].slice(0, RESULT_MAX_LINES);
}
export function buildCommentTableLines(comments: readonly TaskComment[], width: number): string[] {
	if (width < 12) {
		if (comments.length === 0) return ["(no comments)"];
		return comments.slice(0, RESULT_MAX_LINES).map(comment => sanitizeInline(comment.text, "(empty)"));
	}
	const rows: string[] = [];
	const rowBudget = Math.max(1, RESULT_MAX_LINES - 2);
	if (comments.length === 0) {
		rows.push(makeIndentedRow(width, `${FG.dim}(no comments)${RESET}`));
	} else {
		const visibleCount = comments.length > rowBudget ? Math.max(0, rowBudget - 1) : comments.length;
		for (const comment of comments.slice(0, visibleCount)) {
			const author = sanitizeInline(comment.author, "unknown");
			const createdAt = sanitizeInline(comment.created_at);
			const text = sanitizeInline(comment.text, "(empty)");
			const when = createdAt ? ` ${FG.dim}${createdAt}${RESET}` : "";
			rows.push(makeIndentedRow(width, `${FG.accent}${author}${RESET}${when} ${FG.muted}${text}${RESET}`));
		}
		if (comments.length > visibleCount) {
			const remaining = comments.length - visibleCount;
			rows.push(makeIndentedRow(width, `${FG.dim}… ${remaining} more comment${remaining === 1 ? "" : "s"}${RESET}`));
		}
	}
	return [`${FG.accent}comments (${comments.length})${RESET}`, ...rows].slice(0, RESULT_MAX_LINES);
}

function formatTasksStructuredResultLines(
	value: unknown,
	args: unknown,
	width: number,
	isError: boolean,
): string[] | null {
	if (isError || width <= 0) return null;
	const action = normalizeTaskAction(getTasksAction(value, args));
	const { payload } = extractToolPayload(value);
	if (payload === null || payload === undefined) return null;
	const issues = extractTaskIssuePayload(payload);
	const comments = extractTaskCommentPayload(payload);

	if (action === "comments") {
		if (!comments) return null;
		return buildCommentTableLines(comments, width);
	}
	if (TASK_LIST_ACTIONS.has(action)) {
		if (!issues) return null;
		return buildIssueTableLines(action, issues, width);
	}
	if (TASK_SINGLE_ACTIONS.has(action)) {
		if (!issues || issues.length === 0) return null;
		if (issues.length === 1) return buildIssueCardLines(issues[0]!, width, action);
		return buildIssueTableLines(action, issues, width);
	}
	if (comments) return buildCommentTableLines(comments, width);
	if (!issues) return null;
	if (issues.length === 1) return buildIssueCardLines(issues[0]!, width, action);
	return buildIssueTableLines(action, issues, width);
}

function formatTasksResultPreview(value: unknown, args: unknown, isError: boolean): string {
	const action = getTasksAction(value, args);
	const label = action ? `tasks ${action}` : "tasks";
	const { record, payload } = extractToolPayload(value);
	const payloadRec = asRecord(payload);
	const argsRec = asRecord(args);
	const argTaskId = argsRec && typeof argsRec.id === "string" ? argsRec.id.trim() : "";
	if (isError) {
		const errorMessage =
			(typeof payloadRec?.error === "string" && payloadRec.error.trim()) ||
			(typeof record?.error === "string" && record.error.trim()) ||
			"request failed";
		return `${label}: ${errorMessage}`;
	}
	if (payload === null || payload === undefined) return `${label}: ok (no output)`;
	if (Array.isArray(payload)) {
		const count = payload.length;
		if (action === "list" || action === "search" || action === "ready" || action === "query") {
			return `Listed ${count} task${count === 1 ? "" : "s"}`;
		}
		if (action === "comment_add") return `Added comment (${Math.max(1, count)})`;
		if (action === "comments") return `Loaded ${count} comment${count === 1 ? "" : "s"}`;
		return `${label}: ${count} item${count === 1 ? "" : "s"}`;
	}
	if (payloadRec) {
		const id = typeof payloadRec.id === "string" && payloadRec.id.trim() ? payloadRec.id.trim() : argTaskId;
		if (action === "create" && id) return `Created task ${id}`;
		if (action === "show" && id) return `Loaded task ${id}`;
		if (action === "comment_add") {
			const count = Array.isArray(payloadRec.comments) ? Math.max(1, payloadRec.comments.length) : 1;
			return `Added comment (${count})`;
		}
		if (action === "update" && id) return `Updated task ${id}`;
		if (action === "close" && id) return `Closed task ${id}`;

		const collection = Array.isArray(payloadRec.tasks)
			? payloadRec.tasks
			: Array.isArray(payloadRec.issues)
				? payloadRec.issues
				: Array.isArray(payloadRec.results)
					? payloadRec.results
					: null;
		if (collection && (action === "list" || action === "search" || action === "ready" || action === "query")) {
			return `Listed ${collection.length} task${collection.length === 1 ? "" : "s"}`;
		}
		if (Array.isArray(payloadRec.comments) && action === "comments") {
			const count = payloadRec.comments.length;
			return `Loaded ${count} comment${count === 1 ? "" : "s"}`;
		}

		const summary = typeof payloadRec.summary === "string" ? payloadRec.summary.trim() : "";
		if (summary) return `${label}: ${summary}`;
		const message = typeof payloadRec.message === "string" ? payloadRec.message.trim() : "";
		if (message) return `${label}: ${message}`;
		if (id) return `${label}: ${id}`;
	}
	if (typeof payload === "string") {
		const normalized = sanitizeRenderableText(payload);
		if (normalized.trim()) return `${label}: ${squashWhitespace(normalized)}`;
	}
	return `${label}: ok`;
}

function formatStartTasksResultPreview(value: unknown, isError: boolean): string {
	const { record, payload } = extractToolPayload(value);
	const payloadRec = asRecord(payload);
	if (isError) {
		const errorMessage =
			(typeof payloadRec?.error === "string" && payloadRec.error.trim()) ||
			(typeof record?.error === "string" && record.error.trim()) ||
			"request failed";
		return `start_tasks failed: ${errorMessage}`;
	}
	if (payloadRec && payloadRec.ok === false) {
		const message =
			(typeof payloadRec.error === "string" && payloadRec.error.trim()) ||
			(typeof payloadRec.summary === "string" && payloadRec.summary.trim()) ||
			"request failed";
		return `start_tasks failed: ${message}`;
	}
	if (payloadRec) {
		const spawned =
			typeof payloadRec.spawned === "number" && Number.isFinite(payloadRec.spawned)
				? Math.trunc(payloadRec.spawned)
				: null;
		const taskIds =
			Array.isArray(payloadRec.taskIds) && payloadRec.taskIds.every(id => typeof id === "string")
				? (payloadRec.taskIds as string[])
				: [];
		if (spawned !== null && taskIds.length > 0) {
			return `Started task spawning (spawned=${spawned}): ${taskIds.slice(0, 3).join(", ")}`;
		}
		if (spawned !== null) return `Started task spawning (spawned=${spawned})`;
		const summary = typeof payloadRec.summary === "string" ? payloadRec.summary.trim() : "";
		if (summary) return summary;
		const message = typeof payloadRec.message === "string" ? payloadRec.message.trim() : "";
		if (message) return message;
	}
	if (payload === null || payload === undefined) return "Started task spawning";
	if (typeof payload === "string") {
		const normalized = sanitizeRenderableText(payload);
		if (normalized.trim()) return squashWhitespace(normalized);
	}
	return "Started task spawning";
}

/** Set of OMS custom IPC tool names that use the standard { content: [...], details?: {...} } format. */
const OMS_IPC_TOOLS = new Set([
	"delete_task_issue",
	"broadcast_to_workers",
	"replace_agent",
	"interrupt_agent",
	"steer_agent",
	"resume_agent",
	"advance_lifecycle",
	"close_task",
	"list_active_agents",
	"read_message_history",
	"list_task_agents",
	"complain",
	"revoke_complaint",
	"wait_for_agent",
]);

function formatOmsToolResultPreview(toolName: string, value: unknown, isError: boolean): string {
	const text = extractResultText(value);
	if (text.trim()) {
		// The content text is already descriptive (e.g., "delete_task_issue: stopped agents for X; deleted issue X")
		return squashWhitespace(text);
	}

	// Fallback: inspect details/data for summary fields
	const rec = asRecord(value);
	const { payload } = extractToolPayload(value);
	const payloadRec = asRecord(payload);

	if (isError) {
		const errorMessage =
			(typeof payloadRec?.error === "string" && payloadRec.error.trim()) ||
			(typeof rec?.error === "string" && rec.error.trim()) ||
			`${toolName} failed`;
		return errorMessage;
	}

	if (payloadRec) {
		const summary = typeof payloadRec.summary === "string" ? payloadRec.summary.trim() : "";
		if (summary) return summary;
		const message = typeof payloadRec.message === "string" ? payloadRec.message.trim() : "";
		if (message) return message;
		if (payloadRec.ok === true) return `${toolName}: ok`;
	}

	if (payload === null || payload === undefined) return `${toolName}: ok`;
	if (typeof payload === "string") {
		const normalized = sanitizeRenderableText(payload);
		if (normalized.trim()) return squashWhitespace(normalized);
	}

	return `${toolName}: ok`;
}

export function formatToolResultPreview(value: unknown, max = 200, opts?: ToolResultPreviewOptions): string {
	const base = getToolBaseName(opts?.toolName);
	if (base === "tasks") return clipText(formatTasksResultPreview(value, opts?.args, opts?.isError === true), max);
	if (base === "start_tasks") return clipText(formatStartTasksResultPreview(value, opts?.isError === true), max);
	if (base === "wake" || base === "wakeup") return opts?.isError ? "wakeup failed" : "Sent wakeup signal";
	if (OMS_IPC_TOOLS.has(base)) return clipText(formatOmsToolResultPreview(base, value, opts?.isError === true), max);
	if (typeof value === "string") {
		const normalized = sanitizeRenderableText(value);
		if (!normalized.trim()) return "(no output)";
		return tryFormatJson(normalized) ?? previewValue(normalized, max);
	}

	if (value === null || value === undefined) return "(no output)";

	const rec = asRecord(value);
	if (rec) {
		const text = extractResultText(value);
		if (text) return tryFormatJson(text) ?? previewValue(text, max);

		if ("details" in rec) {
			if (rec.details === null || rec.details === undefined) return "(no output)";
			return formatToolResultPreview(rec.details, max);
		}
		if ("data" in rec) {
			if (rec.data === null || rec.data === undefined) return "(no output)";
			return formatToolResultPreview(rec.data, max);
		}

		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return previewValue(value, max);
		}
	}

	return previewValue(value, max);
}

/** Format tool args for header display, extracting the most useful field per tool type. */
export function formatToolArgs(toolName: string, args: unknown): string {
	const rec = asRecord(args);
	if (!rec) return previewValue(args, 80);
	const base = toolName.replace(/^proxy_/, "");
	switch (base) {
		case "read":
			return typeof rec.path === "string" ? rec.path : previewValue(args, 80);
		case "grep":
			return typeof rec.pattern === "string" ? rec.pattern : previewValue(args, 80);
		case "bash":
			return typeof rec.command === "string" ? clipText(squashWhitespace(rec.command), 80) : previewValue(args, 80);
		case "edit":
			return typeof rec.path === "string" ? rec.path : previewValue(args, 80);
		case "write":
			return typeof rec.path === "string" ? rec.path : previewValue(args, 80);
		case "find":
			return typeof rec.pattern === "string" ? rec.pattern : previewValue(args, 80);
		case "lsp":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "fetch":
			return typeof rec.url === "string" ? clipText(rec.url, 80) : previewValue(args, 80);
		case "web_search":
			return typeof rec.query === "string" ? rec.query : previewValue(args, 80);
		case "python":
			return "(code)";
		case "notebook":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "tasks":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "task":
			return typeof rec.description === "string" ? clipText(rec.description, 80) : previewValue(args, 80);
		// OMS custom IPC tools
		case "delete_task_issue":
			return typeof rec.id === "string" ? rec.id : previewValue(args, 80);
		case "broadcast_to_workers":
			return typeof rec.message === "string" ? clipText(squashWhitespace(rec.message), 80) : previewValue(args, 80);
		case "replace_agent": {
			const role = typeof rec.role === "string" ? rec.role : "";
			const tid = typeof rec.taskId === "string" ? rec.taskId : "";
			return role && tid ? `${role} ${tid}` : role || tid || previewValue(args, 80);
		}
		case "interrupt_agent":
		case "steer_agent":
		case "resume_agent":
		case "list_task_agents":
			return typeof rec.taskId === "string" ? rec.taskId : previewValue(args, 80);
		case "close_task":
			return typeof rec.reason === "string" ? clipText(squashWhitespace(rec.reason), 80) : previewValue(args, 80);
		case "advance_lifecycle":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "complain":
			return typeof rec.reason === "string" ? clipText(squashWhitespace(rec.reason), 80) : previewValue(args, 80);
		case "revoke_complaint":
			return Array.isArray(rec.files) ? rec.files.slice(0, 3).join(", ") : previewValue(args, 80);
		case "wait_for_agent":
			return typeof rec.agentId === "string" ? rec.agentId : previewValue(args, 80);
		case "read_message_history":
			return typeof rec.agentId === "string"
				? rec.agentId
				: typeof rec.taskId === "string"
					? rec.taskId
					: previewValue(args, 80);
		case "list_active_agents":
			return "";
		default:
			return previewValue(args, 80);
	}
}

function formatStructuredToolResultLines(block: ToolBlock, contentWidth: number): string[] | null {
	const base = getToolBaseName(block.toolName);
	if (base === "tasks") {
		const source = block.resultData === undefined ? null : block.resultData;
		if (source === null) return null;
		return formatTasksStructuredResultLines(source, block.argsData, contentWidth, block.state === "error");
	}
	return null;
}
function isTaskCommentsResult(block: ToolBlock): boolean {
	if (getToolBaseName(block.toolName) !== "tasks") return false;
	const action = normalizeTaskAction(getTasksAction(block.resultData, block.argsData));
	return action === "comments";
}



export function renderToolBlockLines(block: ToolBlock, width: number): string[] {
	if (width < 8) return [];
	const isTaskComments = isTaskCommentsResult(block);

	const prefixVW = 2;
	const suffixVW = 1;
	const contentWidth = Math.max(1, width - prefixVW - suffixVW);
	const pendingTaskArgs =
		block.state === "pending" && block.argsComplete === false && getToolBaseName(block.toolName) === "tasks"
			? formatPendingTasksCallArgs(block.argsData, contentWidth)
			: null;
	const structuredLines = pendingTaskArgs ? null : formatStructuredToolResultLines(block, contentWidth);
	const contentTextLines: string[] = [];

	const pushTextLine = (text: string): void => {
		const clipped = clipAnsi(text, contentWidth);
		const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		contentTextLines.push(`${clipped}${pad}`);
	};
	if (pendingTaskArgs && pendingTaskArgs.length > 0) {
		const maxLines = RESULT_MAX_LINES;
		for (const line of pendingTaskArgs.slice(0, maxLines)) {
			pushTextLine(`${FG.muted}${line}${RESET_FG}`);
		}
		if (pendingTaskArgs.length > maxLines) {
			pushTextLine(`${FG.dim}… ${pendingTaskArgs.length - maxLines} more lines${RESET_FG}`);
		}
	} else if (structuredLines && structuredLines.length > 0) {
		const maxLines = RESULT_MAX_LINES;
		for (const line of structuredLines.slice(0, maxLines)) {
			pushTextLine(line);
		}
		if (structuredLines.length > maxLines) {
			pushTextLine(`${FG.dim}… ${structuredLines.length - maxLines} more lines${RESET_FG}`);
		}
	} else {
		const rawText = block.resultContent || block.resultPreview;
		const displayText = rawText ? sanitizeRenderableText(tryFormatJson(rawText) ?? rawText) : "";
		if (displayText.trim()) {
			// Split by newlines first, then wrap each logical line
			const logicalLines = displayText.split(/\r?\n/);
			const allWrapped: string[] = [];
			for (const ll of logicalLines) {
				if (ll.length === 0) {
					allWrapped.push("");
				} else {
					allWrapped.push(...wrapLine(ll, contentWidth));
				}
			}
			const maxLines = RESULT_MAX_LINES;
			const isError = block.state === "error";
			const textColor = isError ? FG.error : FG.muted;
			for (const line of allWrapped.slice(0, maxLines)) {
				pushTextLine(`${textColor}${line}${RESET_FG}`);
			}
			if (allWrapped.length > maxLines) {
				pushTextLine(`${FG.dim}… ${allWrapped.length - maxLines} more lines${RESET_FG}`);
			}
		} else {
			const fallback = block.state === "error" ? "(error; no output)" : "(no output)";
			const textColor = block.state === "error" ? FG.error : FG.dim;
			pushTextLine(`${textColor}${fallback}${RESET_FG}`);
		}
	}
	if (isTaskComments) {
		return contentTextLines;
	}

	// State-based colors
	const borderFg = block.state === "error" ? FG.error : block.state === "pending" ? FG.accent : FG.dim;
	const icon = block.state === "error" ? ICON.error : block.state === "pending" ? ICON.pending : ICON.success;
	const bgAnsi = block.state === "error" ? BG.toolError : block.state === "pending" ? BG.toolPending : BG.toolSuccess;
	const bc = (text: string) => `${borderFg}${text}${RESET_FG}`;
	const cap = BOX.h.repeat(CAP_LEN);
	const argsClipped = block.argsPreview ? clipText(block.argsPreview, Math.max(0, width - 25)) : "";
	const argsStr = argsClipped ? ` ${FG.dim}${ICON.dot}${RESET_FG} ${FG.dim}${argsClipped}${RESET_FG}` : "";
	const labelContent = `${icon} ${BOLD}${block.toolName}${UNBOLD}${argsStr}`;
	const rawLabelPadded = ` ${labelContent} `;
	// ---- Top bar ----
	const topLeftStr = bc(`${BOX.tl}${cap}`);
	const topRightStr = bc(BOX.tr);
	const topLeftVW = 1 + CAP_LEN;
	const topRightVW = 1;
	const labelMaxVW = Math.max(0, width - topLeftVW - topRightVW);
	const labelPadded = clipAnsi(rawLabelPadded, labelMaxVW);
	const labelVW = visibleWidth(labelPadded);
	const topFillCount = Math.max(0, width - topLeftVW - labelVW - topRightVW);
	const topLine = `${topLeftStr}${labelPadded}${bc(BOX.h.repeat(topFillCount))}${topRightStr}`;
	const prefixStr = bc(`${BOX.v} `);
	const suffixStr = bc(BOX.v);
	const contentLines = contentTextLines.map(line => `${prefixStr}${line}${suffixStr}`);
	const bottomLeftStr = bc(`${BOX.bl}${cap}`);
	const bottomRightStr = bc(BOX.br);
	const bottomFillCount = Math.max(0, width - (1 + CAP_LEN) - 1);
	const bottomLine = `${bottomLeftStr}${bc(BOX.h.repeat(bottomFillCount))}${bottomRightStr}`;
	// ---- Apply background to all lines ----
	const allLines = [topLine, ...contentLines, bottomLine];
	return allLines.map(line => {
		const clipped = clipAnsi(line, width);
		const vw = visibleWidth(clipped);
		const pad = " ".repeat(Math.max(0, width - vw));
		return `${bgAnsi}${clipped}${pad}${RESET}`;
	});
}

