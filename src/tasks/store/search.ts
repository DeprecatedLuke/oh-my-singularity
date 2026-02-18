import type { TaskDepTreeInput, TaskSearchInput } from "../client";
import type { TaskIssue } from "../types";
import type { ParsedListArgs, StoreSnapshot } from "./types";
import {
	clampPriority,
	comparePriorityThenId,
	normalizeString,
	normalizeToken,
	parseQueryExpression,
} from "./utilities";

export function getIssueText(issue: TaskIssue): string {
	const comments = Array.isArray(issue.comments) ? issue.comments : [];
	const commentText = comments
		.map(comment => (typeof comment.text === "string" ? comment.text : ""))
		.filter(Boolean)
		.join("\n");
	return [issue.id, issue.title, issue.description ?? "", issue.acceptance_criteria ?? "", commentText]
		.join("\n")
		.toLowerCase();
}

export function filterList(issues: TaskIssue[], parsed: ParsedListArgs): TaskIssue[] {
	let filtered = issues;
	if (parsed.type) {
		filtered = filtered.filter(issue => normalizeToken(issue.issue_type) === parsed.type);
	}
	if (parsed.status) {
		filtered = filtered.filter(issue => normalizeToken(issue.status) === parsed.status);
	} else if (!parsed.includeClosed) {
		filtered = filtered.filter(issue => normalizeToken(issue.status) !== "closed");
	}
	filtered.sort(comparePriorityThenId);
	if (parsed.limit != null) return filtered.slice(0, parsed.limit);
	return filtered;
}

export function searchIssues(issues: TaskIssue[], query: string, options?: TaskSearchInput): TaskIssue[] {
	const text = query.trim().toLowerCase();
	if (!text) return [];
	const statusFilter = normalizeToken(options?.status ?? "all");
	const limit =
		typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
			? Math.trunc(options.limit)
			: null;

	let candidates = [...issues];
	if (statusFilter === "open") {
		candidates = candidates.filter(issue => normalizeToken(issue.status) !== "closed");
	} else if (statusFilter === "closed") {
		candidates = candidates.filter(issue => normalizeToken(issue.status) === "closed");
	}

	const matches = candidates.filter(issue => {
		const parts = [issue.id, issue.title, issue.description ?? "", issue.acceptance_criteria ?? ""];
		if (Array.isArray(issue.comments)) {
			for (const comment of issue.comments) {
				if (typeof comment.text === "string") parts.push(comment.text);
			}
		}
		return parts.join("\n").toLowerCase().includes(text);
	});
	matches.sort(comparePriorityThenId);
	if (limit != null) return matches.slice(0, limit);
	return matches;
}

export function queryIssues(issues: TaskIssue[], expr: string, parsedList: ParsedListArgs): TaskIssue[] {
	const query = expr.trim();
	let filtered = filterList(issues, {
		includeClosed: parsedList.includeClosed,
		status: parsedList.status,
		type: parsedList.type,
		limit: null,
	});
	if (!query) {
		if (parsedList.limit != null) return filtered.slice(0, parsedList.limit);
		return filtered;
	}

	const parsedExpr = parseQueryExpression(query);
	if (parsedExpr.status) {
		filtered = filtered.filter(issue => normalizeToken(issue.status) === parsedExpr.status);
	}
	if (parsedExpr.type) {
		filtered = filtered.filter(issue => normalizeToken(issue.issue_type) === parsedExpr.type);
	}
	if (parsedExpr.assignee) {
		filtered = filtered.filter(issue => normalizeString(issue.assignee) === parsedExpr.assignee);
	}
	if (parsedExpr.id) {
		filtered = filtered.filter(issue => issue.id === parsedExpr.id);
	}
	if (typeof parsedExpr.priority === "number") {
		filtered = filtered.filter(issue => clampPriority(issue.priority) === parsedExpr.priority);
	}
	if (parsedExpr.freeText) {
		filtered = filtered.filter(issue => getIssueText(issue).includes(parsedExpr.freeText));
	}
	filtered.sort(comparePriorityThenId);
	if (parsedList.limit != null) return filtered.slice(0, parsedList.limit);
	return filtered;
}

export function buildDependencyTree(state: StoreSnapshot, rootId: string, options?: TaskDepTreeInput): unknown {
	const maxDepth =
		typeof options?.maxDepth === "number" && Number.isFinite(options.maxDepth) && options.maxDepth > 0
			? Math.trunc(options.maxDepth)
			: 20;
	const direction = normalizeString(options?.direction) ?? "down";
	const statusFilter = normalizeString(options?.status)?.toLowerCase() ?? null;

	const buildDown = (issueId: string, depth: number, seen: Set<string>): unknown => {
		const issue = state.issues[issueId];
		if (!issue) return null;
		const node: Record<string, unknown> = {
			id: issue.id,
			title: issue.title,
			status: issue.status,
		};
		if (depth >= maxDepth || seen.has(issueId)) {
			node.dependencies = [];
			return node;
		}
		seen.add(issueId);
		const children = issue.depends_on_ids
			.map(depId => buildDown(depId, depth + 1, seen))
			.filter(child => child !== null) as unknown[];
		node.dependencies = children;
		seen.delete(issueId);
		return node;
	};

	const buildUp = (issueId: string, depth: number, seen: Set<string>): unknown => {
		const issue = state.issues[issueId];
		if (!issue) return null;
		const node: Record<string, unknown> = {
			id: issue.id,
			title: issue.title,
			status: issue.status,
		};
		if (depth >= maxDepth || seen.has(issueId)) {
			node.dependents = [];
			return node;
		}
		seen.add(issueId);
		const dependents = Object.values(state.issues)
			.filter(candidate => candidate.depends_on_ids.includes(issueId))
			.map(candidate => buildUp(candidate.id, depth + 1, seen))
			.filter(child => child !== null) as unknown[];
		node.dependents = dependents;
		seen.delete(issueId);
		return node;
	};

	const payload: Record<string, unknown> = {
		id: rootId,
		direction,
		maxDepth,
	};
	if (direction === "up") {
		payload.tree = buildUp(rootId, 0, new Set<string>());
	} else if (direction === "both") {
		payload.down = buildDown(rootId, 0, new Set<string>());
		payload.up = buildUp(rootId, 0, new Set<string>());
	} else {
		payload.tree = buildDown(rootId, 0, new Set<string>());
	}

	if (statusFilter) {
		payload.status = statusFilter;
	}
	return payload;
}
