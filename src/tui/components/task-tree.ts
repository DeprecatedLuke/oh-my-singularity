import type { TaskIssue } from "../../tasks/types";
import { clipAnsi, FG, RESET, visibleWidth } from "../colors";

export type TaskTreeLine = {
	issue: TaskIssue;
	depth: number;
	text: string;
	/** Compact aggregate usage badge for task lines, e.g. "[42k $0.12]". */
	taskUsageBadge?: string;
	/** If set, this line represents an agent working on the issue. Value is AgentInfo.id. */
	agentId?: string;
	/** AgentStatus string, used for color tinting agent lines. */
	agentStatus?: string;
	/** AgentRole string, used for role-based color tinting. */
	agentRole?: string;
	/** Render hint for de-emphasized synthetic lines (e.g., collapsed orphaned agents). */
	dim?: boolean;
	/** True when this line is an orphaned active agent (no/open task association). */
	orphaned?: boolean;
};

function normalizeStatusToken(status: unknown): string {
	return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function isClosedOrDoneStatus(status: unknown): boolean {
	const normalized = normalizeStatusToken(status);
	return normalized === "closed" || normalized === "done" || normalized === "complete" || normalized === "completed";
}
function isWorkItem(issue: TaskIssue): boolean {
	// Keep the left pane focused on human work; exclude agent/rig/system records.
	const labels = Array.isArray(issue.labels) ? issue.labels : [];
	const agentState = (issue as { agent_state?: unknown }).agent_state;
	if (typeof agentState === "string" && agentState.trim()) return false;
	if (labels.includes("gt:agent")) return false;
	const t = issue.issue_type;
	return !(
		t === "agent" ||
		t === "role" ||
		t === "rig" ||
		t === "convoy" ||
		t === "event" ||
		t === "slot" ||
		t === "molecule" ||
		t === "gate"
	);
}

function dependencyIdFromRecord(record: unknown): string | null {
	if (!record || typeof record !== "object") return null;
	const rec = record as { id?: unknown; depends_on_id?: unknown };
	if (typeof rec.depends_on_id === "string" && rec.depends_on_id.trim()) return rec.depends_on_id.trim();
	if (typeof rec.id === "string" && rec.id.trim()) return rec.id.trim();
	return null;
}

function collectDependencyIds(issue: TaskIssue): string[] {
	const dependencyIds: string[] = [];
	const seen = new Set<string>();
	const dependsOnIds = (issue as { depends_on_ids?: unknown }).depends_on_ids;
	if (Array.isArray(dependsOnIds)) {
		for (const dependency of dependsOnIds) {
			if (typeof dependency !== "string") continue;
			const normalizedDependency = dependency.trim();
			if (!normalizedDependency || seen.has(normalizedDependency)) continue;
			seen.add(normalizedDependency);
			dependencyIds.push(normalizedDependency);
		}
	}
	const dependencies = (issue as { dependencies?: unknown }).dependencies;
	if (Array.isArray(dependencies)) {
		for (const dependency of dependencies) {
			const dependencyId = dependencyIdFromRecord(dependency);
			if (!dependencyId || seen.has(dependencyId)) continue;
			seen.add(dependencyId);
			dependencyIds.push(dependencyId);
		}
	}
	return dependencyIds;
}
export function statusMarker(status: string): string {
	switch (status) {
		case "open":
			return `${FG.muted}[ ]${RESET}`;
		case "in_progress":
			return `${FG.accent}[~]${RESET}`;
		case "closed":
			return `${FG.success}[x]${RESET}`;
		case "blocked":
			return `${FG.error}[!]${RESET}`;
		case "deferred":
			return `${FG.dim}[-]${RESET}`;
		default:
			return `${FG.dim}[?]${RESET}`;
	}
}
function statusSortGroup(status: string): number {
	switch (status) {
		case "open":
		case "in_progress":
			return 0;
		case "blocked":
			return 1;
		case "deferred":
			return 2;
		case "closed":
			return 3;
		default:
			return 1;
	}
}
function comparePriorityThenTitle(a: TaskIssue, b: TaskIssue): number {
	const ga = statusSortGroup(String(a.status));
	const gb = statusSortGroup(String(b.status));
	if (ga !== gb) return ga - gb;
	if (String(a.status) === "closed" && String(b.status) === "closed") {
		const ta = Date.parse(typeof a.updated_at === "string" ? a.updated_at : "");
		const tb = Date.parse(typeof b.updated_at === "string" ? b.updated_at : "");
		const sa = Number.isFinite(ta) ? ta : Number.NEGATIVE_INFINITY;
		const sb = Number.isFinite(tb) ? tb : Number.NEGATIVE_INFINITY;
		if (sa > sb) return -1;
		if (sa < sb) return 1;
	}
	const pa = typeof a.priority === "number" ? a.priority : 999;
	const pb = typeof b.priority === "number" ? b.priority : 999;
	if (pa !== pb) return pa - pb;
	const ta = a.title ?? "";
	const tb = b.title ?? "";
	return ta.localeCompare(tb);
}
function clip(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	return `${clipAnsi(text, width - 1)}…`;
}

function createsParentCycle(
	parentByIssueId: ReadonlyMap<string, string>,
	issueId: string,
	candidateParentId: string,
): boolean {
	let parentId: string | undefined = candidateParentId;
	const seen = new Set<string>([issueId]);
	while (parentId) {
		if (seen.has(parentId)) return true;
		seen.add(parentId);
		parentId = parentByIssueId.get(parentId);
	}
	return false;
}

function renderStatusHint(issue: TaskIssue, hasActiveDeps: boolean): string {
	if (!hasActiveDeps && normalizeStatusToken(issue.status) === "open") {
		return ` ${FG.success}(ready)${RESET}`;
	}
	return "";
}
export function renderTaskTreeLines(issues: readonly TaskIssue[], width: number): TaskTreeLine[] {
	const workItems = issues.filter(isWorkItem).slice().sort(comparePriorityThenTitle);
	const issueById = new Map(workItems.map(issue => [issue.id, issue]));
	const activeDependenciesByIssueId = new Map<string, string[]>();
	for (const issue of workItems) {
		const activeDependencies = collectDependencyIds(issue).filter(dependencyId => {
			const dependencyIssue = issueById.get(dependencyId);
			if (!dependencyIssue) return false;
			return !isClosedOrDoneStatus(dependencyIssue.status);
		});
		activeDependenciesByIssueId.set(issue.id, activeDependencies);
	}

	const parentByIssueId = new Map<string, string>();
	for (const issue of workItems) {
		const dependencies = activeDependenciesByIssueId.get(issue.id) ?? [];
		for (const dependencyId of dependencies) {
			if (dependencyId === issue.id) continue;
			if (createsParentCycle(parentByIssueId, issue.id, dependencyId)) continue;
			parentByIssueId.set(issue.id, dependencyId);
			break;
		}
	}

	const childrenByIssueId = new Map<string, TaskIssue[]>();
	for (const issue of workItems) {
		const parentId = parentByIssueId.get(issue.id);
		if (!parentId) continue;
		const children = childrenByIssueId.get(parentId) ?? [];
		children.push(issue);
		childrenByIssueId.set(parentId, children);
	}
	for (const children of childrenByIssueId.values()) {
		children.sort(comparePriorityThenTitle);
	}

	const lines: TaskTreeLine[] = [];
	const renderedIssueIds = new Set<string>();
	const roots = workItems.filter(issue => !parentByIssueId.has(issue.id));

	const renderNode = (issue: TaskIssue, depth: number): void => {
		if (renderedIssueIds.has(issue.id)) return;
		renderedIssueIds.add(issue.id);
		const marker = statusMarker(String(issue.status));
		const prefix = depth > 0 ? `${"  ".repeat(depth)}\u21b3 ` : "";
		const hasActiveDeps = (activeDependenciesByIssueId.get(issue.id) ?? []).length > 0;
		const base = `${prefix}${marker} ${issue.title}${renderStatusHint(issue, hasActiveDeps)}`;
		lines.push({ issue, depth, text: clip(base, width) });
		const children = childrenByIssueId.get(issue.id) ?? [];
		for (const child of children) {
			renderNode(child, depth + 1);
		}
	};

	for (const root of roots) {
		renderNode(root, 0);
	}
	for (const issue of workItems) {
		if (!renderedIssueIds.has(issue.id)) {
			renderNode(issue, 0);
		}
	}

	return lines;
}
