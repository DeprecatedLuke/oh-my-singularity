/**
 * Tasks tool extension for omp.
 *
 * Registers a single tool `tasks` with a constrained set of allowed actions.
 * The outer harness can load different extension modules per agent role to
 * enforce task permissions via tool availability.
 */
import net from "node:net";
import { truncateToWidth } from "@oh-my-pi/pi-natives";
import type { TaskComment, TaskIssue } from "../../tasks/types";
import { sanitizeRenderableText, wrapLine } from "../../tui/components/text-formatter";
import {
	extractTaskCommentPayload,
	extractTaskIssuePayload,
	extractToolPayload,
	formatToolResultPreview,
	getTasksAction,
	normalizeTaskAction,
	TASK_LIST_ACTIONS,
	TASK_SINGLE_ACTIONS,
} from "../../tui/components/tool-renderer";
import { logger } from "../../utils";
import { renderToolCall, renderToolResult } from "./tool-renderers";
import type {
	ExtensionAPI,
	ToolRenderCallOptions,
	ToolRenderResultOptions,
	ToolResultWithError,
	ToolTheme,
	UnknownRecord,
} from "./types";

type TasksExtensionOptions = {
	role?: string;
	allowedActions?: string[];
};

export function makeTasksExtension(opts: TasksExtensionOptions) {
	const role = opts?.role ?? "agent";
	const allowed = new Set(Array.isArray(opts?.allowedActions) ? opts.allowedActions : []);

	return async function tasksExtension(api: ExtensionAPI): Promise<void> {
		const { Type } = api.typebox;

		const tool = {
			name: "tasks",
			label: "Tasks",
			description:
				"Interact with the Tasks issue tracker. Always use this tool for issue tracker operations. Never invoke Tasks CLI via shell (`bash`, scripts, aliases, subshells). Actions are permissioned by the harness.",
			parameters: Type.Object(
				{
					action: Type.String({
						description:
							"Action to perform (e.g. show, list, search, ready, comments, comment_add, create, update, close). " +
							"Note: singularity can use close/update when explicitly requested by user.",
					}),

					// Common
					id: Type.Optional(Type.String({ description: "Issue id" })),
					limit: Type.Optional(Type.Number({ description: "Limit for list-like operations" })),

					// list/search filters
					status: Type.Optional(Type.String({ description: "Filter status for list/search" })),
					type: Type.Optional(Type.String({ description: "Filter type for list" })),
					includeClosed: Type.Optional(
						Type.Boolean({
							description: "If true, include closed issues (tasks list --all)",
						}),
					),

					// comment
					text: Type.Optional(Type.String({ description: "Comment text" })),

					// create
					title: Type.Optional(Type.String({ description: "Title for new issue" })),
					description: Type.Optional(Type.String({ description: "Description for new issue" })),
					labels: Type.Optional(Type.Array(Type.String(), { description: "Labels" })),
					priority: Type.Optional(Type.Number({ description: "Priority (0-4)" })),
					assignee: Type.Optional(Type.String({ description: "Assignee" })),
					depends_on: Type.Optional(
						Type.Union([Type.String(), Type.Array(Type.String())], {
							description: "Depends-on issue id(s) for create/update action",
						}),
					),
					references: Type.Optional(
						Type.Union([Type.String(), Type.Array(Type.String())], {
							description: "Reference issue id(s) for create/update action",
						}),
					),

					// close
					reason: Type.Optional(Type.String({ description: "Close reason" })),

					// update
					newStatus: Type.Optional(Type.String({ description: "New status (tasks update --status)" })),
					claim: Type.Optional(
						Type.Boolean({
							description: "If true, claim the issue (tasks update --claim)",
						}),
					),

					// query / search / dep_tree
					dependsOn: Type.Optional(Type.String({ description: "Depends-on issue id (for update)" })),
					query: Type.Optional(
						Type.String({ description: "Query expression (tasks query) or text search (tasks search)" }),
					),
					direction: Type.Optional(Type.String({ description: "Dependency tree direction (down|up|both)" })),
					maxDepth: Type.Optional(Type.Number({ description: "Max dependency tree depth" })),
				},
				{ additionalProperties: false },
			),
			mergeCallAndResult: true,
			renderCall: (args: Record<string, unknown> | undefined, theme: ToolTheme, options?: ToolRenderCallOptions) => {
				const action = typeof args?.action === "string" ? normalizeTaskAction(args.action) : "";
				const isStreaming = options?.isPartial === true;
				if (isStreaming) {
					const label = action ? `Tasks · ${action}` : "Tasks";
					return renderToolCall(label, formatTasksStreamingCallArgs(args), theme, options);
				}
				const summary = options?.result
					? formatTasksResultHeader(options.result, args)
					: formatTasksCallSummary(args, action);
				return renderToolCall("Tasks", summary ? [summary] : [], theme, options);
			},
			renderResult: (
				result: ToolResultWithError,
				options: ToolRenderResultOptions,
				theme: ToolTheme,
				args?: UnknownRecord,
			) => {
				const fallback = renderToolResult("Tasks", result, options, theme);
				return {
					render(width: number): string[] {
						const structuredLines = formatTasksStructuredRenderLines(result, args, width, options, theme);
						if (structuredLines && structuredLines.length > 0) return structuredLines;
						return fallback.render(width);
					},
				};
			},
			execute: async (_toolCallId: string, params: Record<string, unknown> | undefined) => {
				const action = typeof params?.action === "string" ? params.action : "";

				if (!allowed.has(action)) {
					const workerLifecycleAction =
						(role === "worker" || role === "designer-worker") && (action === "close" || action === "update");
					const singularityLifecycleAction = role === "singularity" && (action === "close" || action === "update");
					const message = workerLifecycleAction
						? `tasks: action not permitted: ${action} (role=${role}). ` +
							"Workers must exit with a concise summary; finisher handles update/close."
						: singularityLifecycleAction
							? `tasks: action not permitted: ${action} (role=${role}). ` +
								"Singularity must not mutate issue lifecycle directly. Use broadcast_to_workers to coordinate, then let steering/finisher handle close/update."
							: `tasks: action not permitted: ${action} (role=${role})`;
					throw new Error(message);
				}

				const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
				if (!sockPath.trim()) {
					throw new Error("tasks: OMS socket not configured (OMS_SINGULARITY_SOCK is empty).");
				}

				const actor = process.env.TASKS_ACTOR ?? `oms-${role}`;
				const defaultTaskId =
					typeof process.env.OMS_TASK_ID === "string" && process.env.OMS_TASK_ID.trim()
						? process.env.OMS_TASK_ID.trim()
						: null;

				try {
					const response = await sendRequest(
						sockPath,
						{
							type: "tasks_request",
							action,
							params,
							actor,
							defaultTaskId,
							ts: Date.now(),
						},
						30_000,
					);

					if (!response || response.ok !== true) {
						const message =
							typeof response?.error === "string" && response.error.trim()
								? response.error.trim()
								: "tasks request failed";
						throw new Error(`tasks: ${message}`);
					}

					const payload = response.data ?? null;
					const text =
						payload === null
							? `tasks ${action}: ok (no output)`
							: `tasks ${action}: ok\n${JSON.stringify(payload, null, 2)}`;

					return {
						content: [{ type: "text", text }],
						details: payload,
					};
				} catch (err) {
					throw new Error(`tasks: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
		};

		api.registerTool(tool);
	};
}

const COLLAPSED_STRUCTURED_LINES = 3;
const EXPANDED_STRUCTURED_LINES = 20;
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
type StructuredRenderResult = {
	lines: string[];
	truncated: boolean;
};

function formatTaskStreamingFieldValue(value: unknown): string {
	if (typeof value === "string") return sanitizeRenderableText(value).trim();
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	if (Array.isArray(value)) {
		const parts = value.map(item => formatTaskStreamingFieldValue(item)).filter(Boolean);
		return parts.length > 0 ? parts.join(", ") : "[]";
	}
	try {
		return sanitizeInline(JSON.stringify(value));
	} catch {
		return sanitizeInline(String(value));
	}
}

function formatTasksStreamingCallArgs(args: UnknownRecord | undefined): string[] {
	const rec = toRecord(args, {});
	const keys = Object.keys(rec).filter(key => key !== "action" && rec[key] !== undefined);
	if (keys.length === 0) return [];
	const orderedKeys = [
		...TASK_STREAMING_ARG_ORDER.filter(key => key !== "action" && key in rec && rec[key] !== undefined),
		...keys.filter(key => !TASK_STREAMING_ARG_KEYS.has(key)).sort((a, b) => a.localeCompare(b)),
	];
	const lines: string[] = [];
	for (const key of orderedKeys) {
		const value = formatTaskStreamingFieldValue(rec[key]);
		if (!value) continue;
		lines.push(`${key}: ${value}`);
	}
	return lines;
}

function formatTasksCallSummary(args: UnknownRecord | undefined, action: string): string {
	const contextHint = formatTasksActionContextHint(action, args);
	const rec = toRecord(args, {});
	if (action === "create") {
		const priority = formatPriorityValue(rec.priority);
		return joinHeaderParts([action, priority ? `P:${priority}` : "", contextHint]);
	}
	if (!action) {
		return contextHint;
	}
	return joinHeaderParts([action, contextHint]);
}

function formatTasksResultHeader(result: ToolResultWithError, args: UnknownRecord | undefined): string {
	const action = normalizeTaskAction(getTasksAction(result, args));
	if (result.isError === true) {
		return formatToolResultPreview(result, 120, {
			toolName: "tasks",
			args,
			isError: true,
		});
	}
	const { payload } = extractToolPayload(result);
	const payloadRec = toRecord(payload, {});
	const argsRec = toRecord(args, {});
	const issues = extractTaskIssuePayload(payload);
	const comments = extractTaskCommentPayload(payload);
	const issueId =
		sanitizeInline(payloadRec.id) ||
		sanitizeInline(argsRec.id) ||
		(issues && issues.length > 0 ? sanitizeInline(issues[0]!.id) : "");

	switch (action) {
		case "create": {
			const priority = formatPriorityValue(payloadRec.priority ?? argsRec.priority);
			return joinHeaderParts([action, priority ? `P:${priority}` : "", issueId]);
		}
		case "search":
		case "query": {
			const query = sanitizeInline(argsRec.query);
			const queryHint = query ? quoteHintText(query) : "";
			const count = issues ? issues.length : formatCollectionCount(payload);
			const prefix = joinHeaderParts([action, queryHint], " ");
			return `${prefix || action} — ${count} result${count === 1 ? "" : "s"}`;
		}
		case "comment_add": {
			const count = comments ? comments.length : formatCommentCount(payload);
			return joinHeaderParts([action, issueId, `(${Math.max(1, count)})`]);
		}
		case "comments": {
			const count = comments ? comments.length : formatCommentCount(payload);
			const prefix = joinHeaderParts([action, issueId]);
			return `${prefix} (${count})`;
		}
		case "list":
		case "ready": {
			const count = issues ? issues.length : formatCollectionCount(payload);
			return `${action} — ${count} task${count === 1 ? "" : "s"}`;
		}
		case "show":
		case "update":
		case "close":
			return joinHeaderParts([action, issueId]);
		default: {
			const fallback = formatToolResultPreview(result, 120, {
				toolName: "tasks",
				args,
				isError: false,
			});
			const normalizedFallback = sanitizeInline(fallback);
			if (normalizedFallback) return normalizedFallback;
			const contextHint = formatTasksActionContextHint(action, args);
			return joinHeaderParts([action || "tasks", contextHint], " ");
		}
	}
}

function formatCollectionCount(payload: unknown): number {
	if (Array.isArray(payload)) return payload.length;
	const rec = toRecord(payload, {});
	if (Array.isArray(rec.tasks)) return rec.tasks.length;
	if (Array.isArray(rec.issues)) return rec.issues.length;
	if (Array.isArray(rec.results)) return rec.results.length;
	return 0;
}

function formatCommentCount(payload: unknown): number {
	if (Array.isArray(payload)) return payload.length;
	const rec = toRecord(payload, {});
	if (Array.isArray(rec.comments)) return rec.comments.length;
	return 0;
}

function formatPriorityValue(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "";
	return String(Math.trunc(value));
}

function joinHeaderParts(parts: readonly string[], separator = "  "): string {
	return parts.filter(part => part.length > 0).join(separator);
}
function formatTasksStructuredRenderLines(
	result: ToolResultWithError,
	args: UnknownRecord | undefined,
	width: number,
	options: ToolRenderResultOptions,
	theme: ToolTheme,
): string[] | null {
	if (width <= 0) return null;
	const { payload } = extractToolPayload(result);
	if (payload === null || payload === undefined) return null;
	const action = normalizeTaskAction(getTasksAction(result, args));
	const issues = extractTaskIssuePayload(payload);
	const comments = extractTaskCommentPayload(payload);
	let structured: StructuredRenderResult | null = null;
	if (action === "comments") {
		if (!comments) return null;
		structured = buildThemedCommentTableLines(comments, width, options.expanded, theme);
	} else if (TASK_LIST_ACTIONS.has(action)) {
		if (!issues) return null;
		structured = buildThemedIssueTableLines(issues, width, options.expanded, theme);
	} else if (TASK_SINGLE_ACTIONS.has(action)) {
		if (!issues || issues.length === 0) return null;
		structured =
			issues.length === 1
				? buildThemedIssueCardLines(issues[0]!, width, options.expanded, theme)
				: buildThemedIssueTableLines(issues, width, options.expanded, theme);
	} else if (comments) {
		structured = buildThemedCommentTableLines(comments, width, options.expanded, theme);
	} else if (issues) {
		structured =
			issues.length === 1
				? buildThemedIssueCardLines(issues[0]!, width, options.expanded, theme)
				: buildThemedIssueTableLines(issues, width, options.expanded, theme);
	}
	if (!structured) return null;
	const lines = structured.lines.slice();
	if (!options.expanded && structured.truncated) {
		lines.push(`  ${theme.fg("dim", "(Ctrl+O for more)")}`);
	}
	return lines.map(line => truncateToWidth(line, width));
}
function formatTasksActionContextHint(action: string, args: UnknownRecord | undefined): string {
	const rec = toRecord(args, {});
	const id = sanitizeInline(rec.id);
	const title = sanitizeInline(rec.title);
	const query = sanitizeInline(rec.query);
	const status = sanitizeInline(rec.status);
	const issueType = sanitizeInline(rec.type);
	const limit =
		typeof rec.limit === "number" && Number.isFinite(rec.limit) && rec.limit > 0 ? String(Math.trunc(rec.limit)) : "";
	const includeClosed = rec.includeClosed === true;
	const filterParts: string[] = [];
	if (status) filterParts.push(`status=${status}`);
	if (issueType) filterParts.push(`type=${issueType}`);
	if (limit) filterParts.push(`limit=${limit}`);
	if (includeClosed) filterParts.push("includeClosed");
	const filterHint = filterParts.length > 0 ? `(${filterParts.join(", ")})` : "";
	const quotedQuery = query ? quoteHintText(query) : "";
	const quotedTitle = title ? quoteHintText(title) : "";
	switch (action) {
		case "search":
		case "query":
			return joinHintParts([quotedQuery, filterHint]);
		case "list":
		case "ready":
			return filterHint;
		case "comments":
		case "comment_add":
		case "show":
		case "close":
			return id;
		case "create":
			return joinHintParts([id, quotedTitle]);
		case "update": {
			const updateParts: string[] = [];
			const newStatus = sanitizeInline(rec.newStatus);
			if (newStatus) updateParts.push(`status=${newStatus}`);
			if (rec.claim === true) updateParts.push("claim");
			const updateHint = updateParts.length > 0 ? `(${updateParts.join(", ")})` : "";
			return joinHintParts([id, updateHint]);
		}
		default:
			return joinHintParts([id, quotedQuery, filterHint, quotedTitle]);
	}
}
function quoteHintText(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}
function joinHintParts(parts: readonly string[]): string {
	return parts.filter(part => part.length > 0).join(" ");
}
function buildThemedIssueCardLines(
	issue: TaskIssue,
	width: number,
	expanded: boolean,
	theme: ToolTheme,
): StructuredRenderResult {
	const taskId = sanitizeInline(issue.id, "(unknown)");
	const title = sanitizeInline(issue.title, "(untitled)");
	const rec = toRecord(issue, {});
	const status = sanitizeInline(rec.status, "(unknown)");
	const issueType = sanitizeInline(rec.issue_type);
	const deps = sanitizeInline(formatTaskDependencies(issue), "none");
	const refs = sanitizeInline(formatTaskReferences(issue), "none");
	const priority = formatPriority(rec.priority);
	const description = sanitizeMultiline(rec.description);
	const details = description || title;
	const detailLimit = expanded ? EXPANDED_STRUCTURED_LINES : COLLAPSED_STRUCTURED_LINES;
	if (width < 12) {
		const compact = formatMultilinePreview(`${taskId} ${details}`, width, detailLimit);
		return {
			lines: compact.lines.map(line => theme.fg("toolOutput", line)),
			truncated: compact.truncated,
		};
	}
	const contentWidth = Math.max(1, width - 2);
	const dot = theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ";
	const detail = formatMultilinePreview(details, contentWidth, detailLimit);
	const headerText = `task ${taskId}${dot}P:${priority}`;
	const statusText = `status ${status}${issueType ? ` (${issueType})` : ""}`;
	const depsText = `deps ${deps}${dot}refs ${refs}`;
	return {
		lines: [
			makeIndentedRow(width, headerText, "accent", theme),
			makeIndentedRow(width, statusText, issueStatusScope(rec.status), theme),
			makeIndentedRow(width, depsText, "dim", theme),
			...detail.lines.map(line => makeIndentedRow(width, line, "toolOutput", theme)),
		],
		truncated: detail.truncated,
	};
}
function buildThemedIssueTableLines(
	issues: readonly TaskIssue[],
	width: number,
	expanded: boolean,
	theme: ToolTheme,
): StructuredRenderResult {
	const rowLimit = expanded ? EXPANDED_STRUCTURED_LINES : COLLAPSED_STRUCTURED_LINES;
	if (width < 12) {
		if (issues.length === 0) {
			return { lines: [theme.fg("dim", "(no tasks)")], truncated: false };
		}
		const visible = issues
			.slice(0, rowLimit)
			.map(issue =>
				theme.fg("toolOutput", `${sanitizeInline(issue.id, "(unknown)")} ${sanitizeInline(issue.title, "")}`),
			);
		return { lines: visible, truncated: issues.length > rowLimit };
	}
	const rows: string[] = [];
	let truncated = false;
	if (issues.length === 0) {
		rows.push(makeIndentedRow(width, "(no tasks)", "dim", theme));
	} else {
		const visibleCount = Math.min(issues.length, rowLimit);
		for (const issue of issues.slice(0, visibleCount)) {
			const rec = toRecord(issue, {});
			const id = sanitizeInline(issue.id, "(unknown)");
			const status = sanitizeInline(rec.status, "(unknown)");
			const priority = formatPriority(rec.priority);
			const deps = sanitizeInline(formatTaskDependencies(issue), "none");
			const title = sanitizeInline(issue.title, "(untitled)");
			const dot = theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ";
			const text = `${id}${dot}${status}${dot}P:${priority}${dot}D:${deps}${dot}${title}`;
			rows.push(makeIndentedRow(width, text, issueStatusScope(rec.status), theme));
		}
		if (issues.length > visibleCount) {
			const remaining = issues.length - visibleCount;
			rows.push(makeIndentedRow(width, `… ${remaining} more task${remaining === 1 ? "" : "s"}`, "dim", theme));
			truncated = true;
		}
	}
	return { lines: rows, truncated };
}
function buildThemedCommentTableLines(
	comments: readonly TaskComment[],
	width: number,
	expanded: boolean,
	theme: ToolTheme,
): StructuredRenderResult {
	const rowLimit = expanded ? EXPANDED_STRUCTURED_LINES : COLLAPSED_STRUCTURED_LINES;
	if (width < 12) {
		if (comments.length === 0) {
			return { lines: [theme.fg("dim", "(no comments)")], truncated: false };
		}
		const visible = comments
			.slice(0, rowLimit)
			.map(comment => theme.fg("toolOutput", sanitizeInline(comment.text, "(empty)")));
		return { lines: visible, truncated: comments.length > rowLimit };
	}
	const rows: string[] = [];
	let truncated = false;
	if (comments.length === 0) {
		rows.push(makeIndentedRow(width, "(no comments)", "dim", theme));
	} else {
		const visibleCount = Math.min(comments.length, rowLimit);
		for (const comment of comments.slice(0, visibleCount)) {
			const author = sanitizeInline(comment.author, "unknown");
			const createdAt = sanitizeInline(comment.created_at);
			const text = sanitizeInline(comment.text, "(empty)");
			const dot = theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ";
			const prefix = createdAt ? `${author}${dot}${createdAt}` : author;
			rows.push(makeIndentedRow(width, `${prefix}${dot}${text}`, "toolOutput", theme));
		}
		if (comments.length > visibleCount) {
			const remaining = comments.length - visibleCount;
			rows.push(makeIndentedRow(width, `… ${remaining} more comment${remaining === 1 ? "" : "s"}`, "dim", theme));
			truncated = true;
		}
	}
	return { lines: rows, truncated };
}
function formatMultilinePreview(text: string, width: number, maxLines: number): StructuredRenderResult {
	const wrapped = wrapLine(text, Math.max(1, width));
	const normalized = wrapped.length > 0 ? wrapped : [""];
	if (normalized.length <= maxLines) {
		return {
			lines: normalized,
			truncated: false,
		};
	}
	const lines = normalized.slice(0, maxLines);
	const tail = lines[maxLines - 1] ?? "";
	lines[maxLines - 1] = truncateToWidth(`${tail}…`, Math.max(1, width));
	return {
		lines,
		truncated: true,
	};
}
function issueStatusScope(status: unknown): string {
	const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
	switch (normalized) {
		case "closed":
		case "done":
		case "complete":
		case "completed":
			return "success";
		case "in_progress":
		case "in-progress":
		case "running":
		case "working":
		case "started":
		case "deferred":
		case "paused":
			return "warning";
		case "blocked":
		case "dead":
		case "failed":
		case "aborted":
		case "stuck":
			return "error";
		case "open":
			return "toolOutput";
		default:
			return "muted";
	}
}
function formatTaskDependencies(issue: TaskIssue): string {
	const rec = toRecord(issue, {});
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
	const rec = toRecord(issue, {});
	const references = extractTaskIdList(rec.references);
	if (references.length > 0) return references.join(", ");
	const rawReferences = sanitizeInline(rec.references);
	if (rawReferences) return rawReferences;
	return "none";
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
		const rec = toRecord(item, {});
		if (typeof rec.id !== "string") continue;
		const normalized = sanitizeInline(rec.id);
		if (normalized) out.push(normalized);
	}
	return out;
}
function sanitizeInline(value: unknown, fallback = ""): string {
	if (typeof value !== "string") return fallback;
	const normalized = sanitizeRenderableText(value).replace(/\s+/g, " ").trim();
	return normalized || fallback;
}
function sanitizeMultiline(value: unknown): string {
	if (typeof value !== "string") return "";
	const normalized = sanitizeRenderableText(value)
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.join("\n")
		.trim();
	return normalized;
}
function makeIndentedRow(width: number, text: string, scope: string, theme: ToolTheme): string {
	const contentWidth = Math.max(1, width - 2);
	return `  ${theme.fg(scope, padInline(text, contentWidth))}`;
}
function padInline(text: string, width: number): string {
	const clipped = truncateToWidth(text, width);
	if (clipped.length >= width) return clipped;
	return `${clipped}${" ".repeat(width - clipped.length)}`;
}
function formatPriority(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "?";
	return String(Math.trunc(value));
}
function sendRequest(sockPath: string, payload: unknown, timeoutMs = 1500): Promise<UnknownRecord> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let responseText = "";

		const client = net.createConnection({ path: sockPath }, () => {
			client.write(`${JSON.stringify(payload)}\n`);
		});

		client.setEncoding("utf8");
		client.on("data", chunk => {
			responseText += chunk;
		});

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				client.destroy();
			} catch (err) {
				logger.debug("agents/extensions/tasks-tool.ts: best-effort failure after client.destroy();", { err });
			}
			reject(new Error(`Timeout connecting to ${sockPath}`));
		}, timeoutMs);

		client.on("error", err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(err);
		});

		client.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);

			const trimmed = responseText.trim();
			if (!trimmed || trimmed === "ok") {
				resolve({ ok: true, data: null });
				return;
			}

			try {
				const parsed = JSON.parse(trimmed);
				resolve(toRecord(parsed, { ok: true, data: parsed }));
			} catch {
				resolve({ ok: true, data: trimmed });
			}
		});
	});
}

function toRecord(value: unknown, fallback: UnknownRecord): UnknownRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
	return value as UnknownRecord;
}
