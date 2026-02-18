export type TaskIssueStatus = "open" | "in_progress" | "blocked" | "deferred" | "closed" | (string & {});

export type TaskIssueType =
	| "task"
	| "bug"
	| "feature"
	| "epic"
	| "group"
	| "noop"
	| "chore"
	| "merge-request"
	| "molecule"
	| "gate"
	| "agent"
	| "role"
	| "rig"
	| "convoy"
	| "event"
	| "slot"
	| (string & {});

export type TaskIssueScope = "tiny" | "small" | "medium" | "large" | "xlarge";

export interface TaskIssue {
	id: string;
	title: string;

	description: string | null;
	acceptance_criteria: string | null;

	status: TaskIssueStatus;
	priority: number;
	issue_type: TaskIssueType;

	labels: string[];
	assignee: string | null;
	scope?: TaskIssueScope;

	created_at: string;
	updated_at: string;

	comments?: TaskComment[];
	references?: string[];

	/** Task store adds fields over time; keep consumers tolerant. */
	[key: string]: unknown;
}

export interface TaskComment {
	id: number;
	issue_id: string;
	author: string;
	text: string;
	created_at: string;

	[key: string]: unknown;
}

/**
 * `tasks ready --json` and `tasks status --json` include additional summary fields.
 * Keep this loose until we need stronger typing.
 */
export interface TaskStatusSummary {
	[key: string]: unknown;
}

/**
 * `tasks activity --json` events vary by backend and flags (e.g. --details).
 * We only require enough structure to do basic dedupe.
 */
export interface TaskActivityEvent {
	id?: string;
	issue_id?: string;
	type?: string;
	created_at?: string;
	updated_at?: string;

	[key: string]: unknown;
}
