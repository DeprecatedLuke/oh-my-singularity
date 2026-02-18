import type { AgentRegistry } from "../agents/registry";
import type { AgentStatus } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import { TaskCliError } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";

import { checkLabelConflicts } from "./conflict-checker";

function isActiveStatus(status: AgentStatus): boolean {
	// Match AgentRegistry semantics (conservative: only clearly-terminal states are inactive).
	return !(
		status === "done" ||
		status === "failed" ||
		status === "aborted" ||
		status === "stopped" ||
		status === "dead"
	);
}

function compareIssueIds(a: string, b: string): number {
	// `numeric: true` provides stable ordering for ids like "12" vs "2".
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function comparePriorityThenId(a: TaskIssue, b: TaskIssue): number {
	const pa = typeof a.priority === "number" ? a.priority : Number.POSITIVE_INFINITY;
	const pb = typeof b.priority === "number" ? b.priority : Number.POSITIVE_INFINITY;

	if (pa !== pb) return pa - pb;
	return compareIssueIds(a.id, b.id);
}

type DependencyRef = {
	id: string;
	status: string | null;
	dependencyType: string | null;
};

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeStatus(value: unknown): string | null {
	const normalized = normalizeString(value);
	return normalized ? normalized.toLowerCase() : null;
}

function normalizeDependencyType(value: unknown): string | null {
	const normalized = normalizeString(value);
	return normalized ? normalized.toLowerCase() : null;
}

function pushDependencyRef(
	refs: DependencyRef[],
	seen: Set<string>,
	idValue: unknown,
	opts?: { status?: unknown; dependencyType?: unknown },
): void {
	const id = normalizeString(idValue);
	if (!id || seen.has(id)) return;

	refs.push({
		id,
		status: normalizeStatus(opts?.status),
		dependencyType: normalizeDependencyType(opts?.dependencyType),
	});
	seen.add(id);
}

function getDependencyRefs(issue: TaskIssue): DependencyRef[] {
	const refs: DependencyRef[] = [];
	const seen = new Set<string>();

	const dependencies = (issue as { dependencies?: unknown }).dependencies;
	if (Array.isArray(dependencies)) {
		for (const dependency of dependencies) {
			if (!dependency || typeof dependency !== "object") continue;
			const dep = dependency as Record<string, unknown>;
			const dependencyType = dep.type ?? dep.dependency_type;
			const status = dep.status;
			if ("depends_on_id" in dep) {
				pushDependencyRef(refs, seen, dep.depends_on_id, { status, dependencyType });
				continue;
			}
			pushDependencyRef(refs, seen, dep.id, { status, dependencyType });
		}
	}

	const dependsOn = (issue as { depends_on?: unknown }).depends_on;
	if (Array.isArray(dependsOn)) {
		for (const dependency of dependsOn) {
			if (dependency && typeof dependency === "object") {
				const dep = dependency as Record<string, unknown>;
				const dependencyType = dep.type ?? dep.dependency_type;
				const status = dep.status;
				if ("depends_on_id" in dep) {
					pushDependencyRef(refs, seen, dep.depends_on_id, { status, dependencyType });
					continue;
				}
				pushDependencyRef(refs, seen, dep.id, { status, dependencyType });
				continue;
			}
			pushDependencyRef(refs, seen, dependency);
		}
	} else if (dependsOn != null) {
		pushDependencyRef(refs, seen, dependsOn);
	}

	const dependsOnIds = (issue as { depends_on_ids?: unknown }).depends_on_ids;
	if (Array.isArray(dependsOnIds)) {
		for (const dependencyId of dependsOnIds) {
			pushDependencyRef(refs, seen, dependencyId);
		}
	}

	return refs;
}

function isBlockingDependency(_ref: DependencyRef): boolean {
	return true;
}

function looksAlreadyClaimedError(err: unknown): boolean {
	const parts: string[] = [];

	if (err instanceof TaskCliError) {
		parts.push(err.message, err.stderr, err.stdout);
	} else if (err instanceof Error) {
		parts.push(err.message);
	} else {
		parts.push(String(err));
	}

	const text = parts.join("\n").toLowerCase();

	// Keep this intentionally fuzzy: tasks backends may vary wording.
	// We only swallow errors that clearly indicate a claim race.
	const patterns: RegExp[] = [
		/already\s+claimed/,
		/already\s+assigned/,
		/already\s+taken/,
		/claimed\s+by\s+/,
		/cannot\s+claim[\s\S]*already/,
		/assignee[\s\S]*already/,
	];

	return patterns.some(re => re.test(text));
}

export class Scheduler {
	private readonly tasksClient: TaskStoreClient;
	private readonly registry: AgentRegistry;
	private readonly tasksAvailable: boolean;

	constructor(opts: { tasksClient: TaskStoreClient; registry: AgentRegistry; tasksAvailable?: boolean }) {
		this.tasksClient = opts.tasksClient;
		this.registry = opts.registry;
		this.tasksAvailable = opts.tasksAvailable ?? true;
	}

	isTasksAvailable(): boolean {
		return this.tasksAvailable;
	}

	private async filterTasksWithClosedDependencies(tasks: TaskIssue[]): Promise<TaskIssue[]> {
		if (tasks.length === 0) return tasks;

		const dependencyRefsByTask = new Map<string, DependencyRef[]>();
		const dependencyClosedById = new Map<string, boolean>();
		const unresolvedDependencyIds = new Set<string>();
		const blockedTaskIds = new Set<string>();

		for (const task of tasks) {
			let refs = getDependencyRefs(task)
				.filter(ref => isBlockingDependency(ref))
				.filter(ref => ref.id !== task.id);
			const dependencyCount =
				typeof (task as { dependency_count?: unknown }).dependency_count === "number"
					? ((task as { dependency_count?: number }).dependency_count ?? 0)
					: 0;

			if (refs.length === 0 && dependencyCount > 0) {
				try {
					const detailedTask = await this.tasksClient.show(task.id);
					refs = getDependencyRefs(detailedTask)
						.filter(ref => isBlockingDependency(ref))
						.filter(ref => ref.id !== task.id);
				} catch {
					blockedTaskIds.add(task.id);
				}
			}

			dependencyRefsByTask.set(task.id, refs);
			for (const ref of refs) {
				if (ref.status) {
					const isClosed = ref.status === "closed";
					const existing = dependencyClosedById.get(ref.id);
					dependencyClosedById.set(ref.id, existing === false ? false : isClosed);
					continue;
				}
				if (!dependencyClosedById.has(ref.id)) unresolvedDependencyIds.add(ref.id);
			}
		}

		if (unresolvedDependencyIds.size > 0) {
			const checks = await Promise.all(
				[...unresolvedDependencyIds].map(async dependencyId => {
					try {
						const issue = await this.tasksClient.show(dependencyId);
						return {
							dependencyId,
							closed: normalizeStatus(issue.status) === "closed",
						};
					} catch {
						return {
							dependencyId,
							closed: false,
						};
					}
				}),
			);

			for (const check of checks) {
				dependencyClosedById.set(check.dependencyId, check.closed);
			}
		}

		return tasks.filter(task => {
			if (blockedTaskIds.has(task.id)) return false;
			const refs = dependencyRefsByTask.get(task.id) ?? [];
			return refs.every(ref => dependencyClosedById.get(ref.id) === true);
		});
	}

	async findTasksUnblockedBy(closedTaskId: string): Promise<TaskIssue[]> {
		const normalizedClosedTaskId = closedTaskId.trim();
		if (!normalizedClosedTaskId) return [];

		const openTasks = await this.tasksClient.list();
		const directDependents = openTasks.filter(issue => {
			const dependsOnIds = (issue as { depends_on_ids?: unknown }).depends_on_ids;
			return (
				issue.issue_type === "task" && Array.isArray(dependsOnIds) && dependsOnIds.includes(normalizedClosedTaskId)
			);
		});
		return this.filterTasksWithClosedDependencies(directDependents);
	}

	async getNextTasks(count: number): Promise<TaskIssue[]> {
		if (count <= 0) return [];

		const readyIssues = await this.tasksClient.ready();
		const readyById = new Map<string, TaskIssue>();
		for (const issue of readyIssues) {
			if (issue.issue_type !== "task") continue;
			if (!readyById.has(issue.id)) readyById.set(issue.id, issue);
		}

		const readyTasks = [...readyById.values()].filter(task => {
			const activeAgents = this.registry.getByTask(task.id).filter(a => isActiveStatus(a.status));
			return activeAgents.length === 0;
		});

		const dependencyReady = await this.filterTasksWithClosedDependencies(readyTasks);
		if (dependencyReady.length === 0) return [];

		const inProgressIssues = await this.tasksClient.list(["--status", "in_progress"]);
		const nonConflicting = dependencyReady.filter(candidate => {
			const result = checkLabelConflicts(candidate.labels, inProgressIssues);
			return !result.conflicting;
		});

		if (nonConflicting.length === 0) return [];
		nonConflicting.sort(comparePriorityThenId);
		return nonConflicting.slice(0, count);
	}

	async getNextTask(): Promise<TaskIssue | null> {
		const tasks = await this.getNextTasks(1);
		return tasks[0] ?? null;
	}

	async getInProgressTasksWithoutAgent(count: number): Promise<TaskIssue[]> {
		if (count <= 0) return [];
		const inProgressIssues = await this.tasksClient.list(["--status", "in_progress"]);
		const inProgressTasks = inProgressIssues
			.filter(issue => issue.issue_type === "task")
			.filter(task => {
				const activeAgents = this.registry.getByTask(task.id).filter(a => isActiveStatus(a.status));
				return activeAgents.length === 0;
			});

		if (inProgressTasks.length === 0) return [];
		inProgressTasks.sort(comparePriorityThenId);
		return inProgressTasks.slice(0, count);
	}
	async getInProgressTaskWithoutAgent(): Promise<TaskIssue | null> {
		const tasks = await this.getInProgressTasksWithoutAgent(1);
		return tasks[0] ?? null;
	}

	async tryClaim(taskId: string): Promise<boolean> {
		try {
			await this.tasksClient.claim(taskId);
			return true;
		} catch (err) {
			if (looksAlreadyClaimedError(err)) return false;
			throw err;
		}
	}
}
