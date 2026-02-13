import crypto from "node:crypto";

import type { TaskComment, TaskIssue } from "../types";
import {
	type ParsedListArgs,
	STORE_VERSION,
	type StoredDependency,
	type StoredUsage,
	type StoreSnapshot,
} from "./types";

export function nowIso(): string {
	return new Date().toISOString();
}

export function parseTimestampMs(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	const ms = Date.parse(trimmed);
	return Number.isFinite(ms) ? ms : null;
}

export function normalizeToken(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function clampPriority(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 2;
	return Math.max(0, Math.min(4, Math.trunc(value)));
}

export function compareIssueIds(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

export function comparePriorityThenId(a: TaskIssue, b: TaskIssue): number {
	const pa = typeof a.priority === "number" ? a.priority : Number.POSITIVE_INFINITY;
	const pb = typeof b.priority === "number" ? b.priority : Number.POSITIVE_INFINITY;
	if (pa !== pb) return pa - pb;
	return compareIssueIds(a.id, b.id);
}

export function sanitizeIssueId(id: string): string {
	const trimmed = id.trim();
	if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
		throw new Error(`Invalid issue id: ${id}`);
	}
	return trimmed;
}

export function normalizeLabels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		const label = item.trim();
		if (!label) continue;
		out.add(label);
	}
	return [...out];
}

export function normalizeComments(value: unknown, issueId: string): TaskComment[] {
	if (!Array.isArray(value)) return [];
	const out: TaskComment[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const text = normalizeString(rec.text);
		if (!text) continue;
		out.push({
			id: typeof rec.id === "number" && Number.isFinite(rec.id) ? Math.trunc(rec.id) : 0,
			issue_id: normalizeString(rec.issue_id) ?? issueId,
			author: normalizeString(rec.author) ?? "unknown",
			text,
			created_at: normalizeString(rec.created_at) ?? nowIso(),
		});
	}
	out.sort((a, b) => (a.id === b.id ? a.created_at.localeCompare(b.created_at) : a.id - b.id));
	return out;
}

export function normalizeDependsOnIds(value: unknown): string[] {
	const out = new Set<string>();
	if (Array.isArray(value)) {
		for (const item of value) {
			const id = normalizeString(item);
			if (id) out.add(id);
		}
	} else {
		const one = normalizeString(value);
		if (one) out.add(one);
	}
	return [...out];
}

export function normalizeDependencies(value: unknown): StoredDependency[] {
	if (!Array.isArray(value)) return [];
	const out: StoredDependency[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const rec = item as Record<string, unknown>;
		const id = normalizeString(rec.depends_on_id) ?? normalizeString(rec.id);
		if (!id) continue;
		out.push({
			...rec,
			id,
			depends_on_id: id,
			status: normalizeString(rec.status) ?? undefined,
			type: normalizeString(rec.type) ?? normalizeString(rec.dependency_type) ?? undefined,
			dependency_type: normalizeString(rec.dependency_type) ?? normalizeString(rec.type) ?? undefined,
			created_at: normalizeString(rec.created_at) ?? undefined,
			updated_at: normalizeString(rec.updated_at) ?? undefined,
		});
	}
	return out;
}

export function parseListArgs(args?: readonly string[]): ParsedListArgs {
	let includeClosed = false;
	let status: string | null = null;
	let type: string | null = null;
	let limit: number | null = null;

	const flags = args ?? [];
	for (let i = 0; i < flags.length; i += 1) {
		const flag = flags[i];
		if (flag === "--all") {
			includeClosed = true;
			continue;
		}

		if (flag === "--status") {
			const value = flags[i + 1];
			if (typeof value === "string") {
				status = normalizeToken(value);
				i += 1;
			}
			continue;
		}

		if (flag === "--type") {
			const value = flags[i + 1];
			if (typeof value === "string") {
				type = normalizeToken(value);
				i += 1;
			}
			continue;
		}

		if (flag === "--limit") {
			const value = flags[i + 1];
			if (typeof value === "string") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					if (parsed <= 0) {
						limit = null;
					} else {
						limit = Math.trunc(parsed);
					}
				}
				i += 1;
			}
		}
	}

	return {
		includeClosed,
		status,
		type,
		limit,
	};
}

export function toStoredUsage(value: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}): StoredUsage {
	const normalize = (n: unknown): number => {
		if (typeof n !== "number" || !Number.isFinite(n)) return 0;
		return n > 0 ? n : 0;
	};
	return {
		input: normalize(value.input),
		output: normalize(value.output),
		cacheRead: normalize(value.cacheRead),
		cacheWrite: normalize(value.cacheWrite),
		totalTokens: normalize(value.totalTokens),
		cost: normalize(value.cost),
	};
}

export function emptyUsage(): StoredUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}

export function parseQueryExpression(query: string): {
	status: string | null;
	type: string | null;
	assignee: string | null;
	id: string | null;
	priority: number | null;
	freeText: string;
} {
	const statusMatch = /status\s*=\s*"?([A-Za-z0-9_-]+)"?/i.exec(query);
	const typeMatch = /(?:type|issue_type)\s*=\s*"?([A-Za-z0-9_-]+)"?/i.exec(query);
	const assigneeMatch = /assignee\s*=\s*"?([^"\s]+)"?/i.exec(query);
	const idMatch = /id\s*=\s*"?([^"\s]+)"?/i.exec(query);
	const priorityMatch = /priority\s*=\s*"?([0-9]+)"?/i.exec(query);
	const freeText = query
		.replace(/status\s*=\s*"?[A-Za-z0-9_-]+"?/gi, " ")
		.replace(/(?:type|issue_type)\s*=\s*"?[A-Za-z0-9_-]+"?/gi, " ")
		.replace(/assignee\s*=\s*"?[^"\s]+"?/gi, " ")
		.replace(/id\s*=\s*"?[^"\s]+"?/gi, " ")
		.replace(/priority\s*=\s*"?[0-9]+"?/gi, " ")
		.trim()
		.toLowerCase();

	return {
		status: statusMatch?.[1] ? normalizeToken(statusMatch[1]) : null,
		type: typeMatch?.[1] ? normalizeToken(typeMatch[1]) : null,
		assignee: assigneeMatch?.[1] ? assigneeMatch[1].trim() : null,
		id: idMatch?.[1] ? idMatch[1].trim() : null,
		priority:
			typeof priorityMatch?.[1] === "string" && Number.isFinite(Number(priorityMatch[1]))
				? Math.trunc(Number(priorityMatch[1]))
				: null,
		freeText,
	};
}

export function buildActivityEventId(): string {
	return `evt-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export function createEmptyStore(): StoreSnapshot {
	return {
		version: STORE_VERSION,
		nextCommentId: 1,
		issues: {},
		activity: [],
		agentLogs: {},
	};
}

export function createId(prefix: string): string {
	const normalizedPrefix =
		typeof prefix === "string" && prefix.trim()
			? prefix
					.trim()
					.toLowerCase()
					.replace(/[^a-z0-9._-]+/g, "-")
					.replace(/^-+|-+$/g, "") || "task"
			: "task";
	return `${normalizedPrefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export function generateSlug(source: string): string {
	const normalized = typeof source === "string" ? source.trim().toLowerCase() : "";
	if (!normalized) return "";

	let slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	slug = slug.slice(0, 16);
	return slug.replace(/-+$/g, "");
}

export function createSlugId(slug: string): string {
	return `${slug}-${crypto.randomBytes(2).toString("hex")}`;
}
