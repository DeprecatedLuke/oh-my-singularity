import type { TaskCreateInput, TaskUpdateInput } from "../client";
import type { TaskComment } from "../types";
import { materializeIssue } from "./snapshot";
import {
	type BatchCreateIssueInput,
	type BatchCreateResult,
	type StoredIssue,
	type StoreSnapshot,
	VALID_AGENT_STATUSES,
	VALID_TASK_STATUSES,
} from "./types";
import {
	clampPriority,
	compareIssueIds,
	createAgentId,
	createId,
	createSlugId,
	generateSlug,
	normalizeLabels,
	normalizeString,
	normalizeTaskScope,
	normalizeToken,
	nowIso,
	sanitizeIssueId,
} from "./utilities";

export function requireIssue(state: StoreSnapshot, id: string): StoredIssue {
	const normalizedId = sanitizeIssueId(id);
	const issue = state.issues[normalizedId];
	if (!issue) throw new Error(`Issue not found: ${normalizedId}`);
	return issue;
}

function normalizeCreateDependsOn(value: TaskCreateInput["depends_on"]): string[] {
	if (value === undefined) return [];
	if (typeof value === "string") {
		const dependency = value.trim();
		if (!dependency) throw new Error("create has empty depends_on entry");
		return [dependency];
	}
	if (!Array.isArray(value)) {
		throw new Error("create has invalid depends_on value");
	}
	const dependsOn: string[] = [];
	const seen = new Set<string>();
	for (const dependency of value) {
		if (typeof dependency !== "string") {
			throw new Error("create has invalid depends_on entry");
		}
		const normalizedDependency = dependency.trim();
		if (!normalizedDependency) {
			throw new Error("create has empty depends_on entry");
		}
		if (seen.has(normalizedDependency)) continue;
		seen.add(normalizedDependency);
		dependsOn.push(normalizedDependency);
	}
	return dependsOn;
}

function normalizeCreateReferences(value: TaskCreateInput["references"]): string[] {
	if (value === undefined) return [];
	if (typeof value === "string") {
		const reference = value.trim();
		if (!reference) throw new Error("create has empty references entry");
		return [reference];
	}
	if (!Array.isArray(value)) {
		throw new Error("create has invalid references value");
	}
	const references: string[] = [];
	const seen = new Set<string>();
	for (const reference of value) {
		if (typeof reference !== "string") {
			throw new Error("create has invalid references entry");
		}
		const normalizedReference = reference.trim();
		if (!normalizedReference) {
			throw new Error("create has empty references entry");
		}
		if (seen.has(normalizedReference)) continue;
		seen.add(normalizedReference);
		references.push(normalizedReference);
	}
	return references;
}

export function createIssue(
	state: StoreSnapshot,
	actor: string,
	title: string,
	description?: string | null,
	priority?: number,
	options?: TaskCreateInput,
): StoredIssue {
	const now = nowIso();
	const issueType = normalizeString(options?.type) ?? "task";
	const normalizedLabels = normalizeLabels(options?.labels);
	const dependsOn = normalizeCreateDependsOn(options?.depends_on);
	const references = normalizeCreateReferences(options?.references);
	if (issueType === "agent" && !normalizedLabels.includes("gt:agent")) {
		normalizedLabels.push("gt:agent");
	}

	let id: string;
	if (issueType === "agent") {
		id = createAgentId(title.split("-")[0] || "agent");
	} else {
		const source = options?.name?.trim() || title;
		const slug = generateSlug(source);
		if (!slug) {
			id = createId(issueType);
		} else {
			let candidateId: string | null = null;
			for (let attempt = 0; attempt < 3; attempt++) {
				const candidate = createSlugId(slug);
				if (!state.issues[candidate]) {
					candidateId = candidate;
					break;
				}
			}
			id = candidateId ?? createId(issueType);
		}
	}
	for (const dependencyId of dependsOn) {
		// Validate dependency references before mutating state for atomic create behavior.
		requireIssue(state, dependencyId);
	}
	const issueScope = normalizeTaskScope(options?.scope);
	const issue: StoredIssue = {
		id,
		title,
		description: normalizeString(description),
		acceptance_criteria: null,
		status: issueType === "agent" ? "spawning" : "open",
		priority: clampPriority(priority),
		issue_type: issueType,
		labels: normalizedLabels,
		assignee: normalizeString(options?.assignee) ?? (issueType === "agent" ? actor : null),
		created_at: now,
		updated_at: now,
		comments: [],
		references,
		depends_on_ids: [],
		dependencies: [],
	};
	if (issueScope) issue.scope = issueScope;
	if (issueType === "agent") {
		issue.agent_state = issue.status;
		issue.last_activity = now;
	}

	state.issues[issue.id] = issue;
	try {
		for (const dependencyId of dependsOn) {
			addDependency(state, issue.id, dependencyId);
		}
	} catch (err) {
		delete state.issues[issue.id];
		throw err;
	}
	return issue;
}

export function createIssueBatch(
	state: StoreSnapshot,
	actor: string,
	inputs: BatchCreateIssueInput[],
): BatchCreateResult {
	if (inputs.length === 0) {
		throw new Error("Batch create requires at least one issue");
	}

	type NormalizedBatchInput = {
		index: number;
		title: string;
		key?: string;
		dependsOn: string[];
		input: BatchCreateIssueInput;
	};

	const normalizedInputs: NormalizedBatchInput[] = [];
	const keyToIndex = new Map<string, number>();

	for (let index = 0; index < inputs.length; index += 1) {
		const input = inputs[index];
		if (!input || typeof input !== "object") {
			throw new Error(`Invalid batch input at index ${index + 1}`);
		}

		const title = typeof input.title === "string" ? input.title.trim() : "";
		if (!title) {
			throw new Error(`Batch create input at index ${index + 1} has empty title`);
		}

		if (input.depends_on !== undefined && !Array.isArray(input.depends_on)) {
			throw new Error(`Batch create input ${index + 1} has invalid depends_on value`);
		}

		const dependsOn: string[] = [];
		const dependencySet = new Set<string>();
		for (const dependency of input.depends_on ?? []) {
			if (typeof dependency !== "string") {
				throw new Error(`Batch create input ${index + 1} has invalid depends_on entry`);
			}
			if (!dependency) {
				throw new Error(`Batch create input ${index + 1} has empty depends_on entry`);
			}
			if (!dependencySet.has(dependency)) {
				dependencySet.add(dependency);
				dependsOn.push(dependency);
			}
		}

		const key = input.key;
		if (key !== undefined) {
			if (keyToIndex.has(key)) {
				throw new Error(`Batch create has duplicate key: ${key}`);
			}
			keyToIndex.set(key, index);
		}

		normalizedInputs.push({
			index,
			title,
			key,
			dependsOn,
			input,
		});
	}

	for (const input of normalizedInputs) {
		for (const dependency of input.dependsOn) {
			if (keyToIndex.has(dependency) || Object.hasOwn(state.issues, dependency)) {
				continue;
			}
			const label = input.key ? `key "${input.key}"` : `index ${input.index + 1}`;
			throw new Error(`Batch create ${label} references unknown dependency: ${dependency}`);
		}
	}

	const dependencyGraph: Array<number[]> = Array.from({ length: normalizedInputs.length }, () => []);
	for (const input of normalizedInputs) {
		for (const dependency of input.dependsOn) {
			const dependencyIndex = keyToIndex.get(dependency);
			if (dependencyIndex !== undefined) {
				dependencyGraph[input.index]!.push(dependencyIndex);
			}
		}
	}

	const visitState = new Array<number>(normalizedInputs.length).fill(0);
	const stack: number[] = [];
	const order: number[] = [];

	const describeNode = (index: number): string => {
		const node = normalizedInputs[index];
		if (!node) return `index ${index + 1}`;
		if (node.key) return `key:${node.key}`;
		return `index ${index + 1}`;
	};

	const visit = (index: number): void => {
		if (visitState[index] === 1) {
			const repeatAt = stack.lastIndexOf(index);
			const cycle = repeatAt >= 0 ? stack.slice(repeatAt) : [index];
			cycle.push(index);
			throw new Error(`Batch create has circular dependency: ${cycle.map(describeNode).join(" -> ")}`);
		}
		if (visitState[index] === 2) return;

		visitState[index] = 1;
		stack.push(index);
		for (const dependencyIndex of dependencyGraph[index]!) {
			visit(dependencyIndex);
		}
		stack.pop();
		visitState[index] = 2;
		order.push(index);
	};

	for (let i = 0; i < normalizedInputs.length; i += 1) {
		if (visitState[i] === 0) {
			visit(i);
		}
	}

	const keyMap: Record<string, string> = {};
	const createdStored: Array<StoredIssue | undefined> = new Array<StoredIssue | undefined>(normalizedInputs.length);

	for (const index of order) {
		const input = normalizedInputs[index];
		if (!input) {
			throw new Error(`Batch create failed while creating issue at index ${index + 1}`);
		}

		const { depends_on, ...createOptions } = input.input;
		const created = createIssue(
			state,
			actor,
			input.title,
			input.input.description,
			input.input.priority,
			createOptions,
		);
		createdStored[index] = created;
		if (input.key !== undefined) {
			keyMap[input.key] = created.id;
		}
	}

	for (const input of normalizedInputs) {
		const issue = createdStored[input.index];
		if (!issue) {
			throw new Error(`Batch create failed while wiring issue at index ${input.index + 1}`);
		}
		for (const dependency of input.dependsOn) {
			const dependencyIndex = keyToIndex.get(dependency);
			const dependencyId = dependencyIndex === undefined ? dependency : keyMap[dependency];
			if (!dependencyId) {
				throw new Error(`Batch create failed to resolve dependency ${dependency} for index ${input.index + 1}`);
			}
			addDependency(state, issue.id, dependencyId);
		}
	}

	const created = createdStored.filter((issue): issue is StoredIssue => issue !== undefined);
	return {
		issues: created.map(issue => materializeIssue(issue, state)),
		keyMap,
	};
}

export function updateIssue(state: StoreSnapshot, actor: string, id: string, patch: TaskUpdateInput): StoredIssue {
	const issue = requireIssue(state, id);
	if (normalizeToken(issue.status) === "closed") {
		throw new Error(`Cannot update closed task ${issue.id}. Task is closed. Create a new task instead.`);
	}
	let changed = false;
	const now = nowIso();

	if (patch.claim === true) {
		if (normalizeToken(issue.status) !== "open") {
			throw new Error(`Issue ${issue.id} is already claimed`);
		}
		issue.status = "in_progress";
		issue.assignee = actor;
		changed = true;
	}

	const nextStatus = normalizeString(patch.newStatus) ?? normalizeString(patch.status);
	if (nextStatus) {
		const allowed = issue.issue_type === "agent" ? VALID_AGENT_STATUSES : VALID_TASK_STATUSES;
		if (!allowed.has(nextStatus)) {
			throw new Error(
				`Invalid status "${nextStatus}" for ${issue.issue_type ?? "task"} issue ${issue.id}. Valid: ${[...allowed].join(", ")}`,
			);
		}
		issue.status = nextStatus;
		if (issue.issue_type === "agent") issue.agent_state = nextStatus;
		changed = true;
	}

	if (typeof patch.priority === "number" && Number.isFinite(patch.priority)) {
		issue.priority = clampPriority(patch.priority);
		changed = true;
	}

	if (Array.isArray(patch.labels)) {
		issue.labels = normalizeLabels(patch.labels);
		changed = true;
	}

	if (patch.scope !== undefined) {
		const normalizedScope = normalizeTaskScope(patch.scope);
		if (!normalizedScope) {
			throw new Error(
				`Invalid scope "${patch.scope}" for issue ${issue.id}. Expected one of tiny, small, medium, large, xlarge.`,
			);
		}
		issue.scope = normalizedScope;
		changed = true;
	}

	if (patch.references !== undefined) {
		issue.references = normalizeCreateReferences(patch.references);
		changed = true;
	}

	if (patch.assignee === null) {
		issue.assignee = null;
		changed = true;
	} else if (typeof patch.assignee === "string") {
		issue.assignee = normalizeString(patch.assignee);
		changed = true;
	}

	if (changed) issue.updated_at = now;
	return issue;
}

export function closeIssue(state: StoreSnapshot, actor: string, id: string, reason?: string): StoredIssue {
	const issue = requireIssue(state, id);
	const now = nowIso();
	issue.status = "closed";
	issue.closed_at = now;
	issue.close_reason = normalizeString(reason);
	issue.updated_at = now;
	for (const candidate of Object.values(state.issues)) {
		let dependencyUpdated = false;
		for (const dependency of candidate.dependencies) {
			const dependencyId = normalizeString(dependency.depends_on_id);
			const legacyDependencyId = normalizeString(dependency.id);
			if (dependencyId !== issue.id && legacyDependencyId !== issue.id) continue;
			if (normalizeToken(dependency.status) !== "closed") {
				dependency.status = "closed";
				dependencyUpdated = true;
			}
			if (normalizeString(dependency.updated_at) !== now) {
				dependency.updated_at = now;
				dependencyUpdated = true;
			}
		}
		if (dependencyUpdated) candidate.updated_at = now;
	}
	if (reason?.trim()) {
		const comments = issue.comments;
		const comment: TaskComment = {
			id: state.nextCommentId++,
			issue_id: issue.id,
			author: actor,
			text: `[closed] ${reason.trim()}`,
			created_at: now,
		};
		comments.push(comment);
	}
	return issue;
}

export function addLabelToIssue(state: StoreSnapshot, id: string, label: string): StoredIssue {
	const issue = requireIssue(state, id);
	if (!issue.labels.includes(label)) {
		issue.labels.push(label);
		issue.updated_at = nowIso();
	}
	return issue;
}

export function addCommentToIssue(state: StoreSnapshot, actor: string, id: string, text: string): TaskComment {
	const issue = requireIssue(state, id);
	if (normalizeToken(issue.status) === "closed") {
		throw new Error(`Cannot add comment to closed task ${issue.id}. Task is closed. Create a new task instead.`);
	}
	const comment: TaskComment = {
		id: state.nextCommentId++,
		issue_id: issue.id,
		author: actor,
		text,
		created_at: nowIso(),
	};
	issue.comments.push(comment);
	issue.updated_at = comment.created_at;
	return comment;
}

export function addDependency(state: StoreSnapshot, issueId: string, dependsOnId: string): StoredIssue {
	const issue = requireIssue(state, issueId);
	const dependency = requireIssue(state, dependsOnId);
	if (issue.id === dependency.id) {
		throw new Error(`Cannot add self-dependency for ${issue.id}`);
	}
	if (!issue.depends_on_ids.includes(dependency.id)) {
		issue.depends_on_ids.push(dependency.id);
		issue.depends_on_ids.sort(compareIssueIds);
	}
	const existing = issue.dependencies.find(dep => dep.id === dependency.id);
	if (!existing) {
		issue.dependencies.push({
			id: dependency.id,
			depends_on_id: dependency.id,
			status: dependency.status,
			type: "blocks",
			dependency_type: "blocks",
			created_at: nowIso(),
		});
	}
	issue.updated_at = nowIso();
	return issue;
}

export function deleteIssue(state: StoreSnapshot, id: string): { deleted: true; id: string } {
	const issue = requireIssue(state, id);
	delete state.issues[issue.id];
	delete state.agentLogs[issue.id];

	for (const candidate of Object.values(state.issues)) {
		if (candidate.depends_on_ids.includes(issue.id)) {
			candidate.depends_on_ids = candidate.depends_on_ids.filter(depId => depId !== issue.id);
			candidate.dependencies = candidate.dependencies.filter(dep => dep.id !== issue.id);
			candidate.updated_at = nowIso();
		}
	}

	return { deleted: true, id: issue.id };
}
