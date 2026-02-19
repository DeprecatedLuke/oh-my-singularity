import { BOLD, FG, RESET } from "../colors";

export function formatIssueStatus(status: unknown): string {
	return typeof status === "string" ? status : "(unknown)";
}

export function issueStatusColor(status: unknown): string {
	const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
	switch (normalized) {
		case "closed":
		case "done":
		case "complete":
		case "completed":
			return FG.success;
		case "in_progress":
		case "in-progress":
		case "running":
		case "working":
		case "started":
			return FG.warning;
		case "blocked":
		case "dead":
		case "failed":
		case "aborted":
		case "stuck":
			return FG.error;
		case "deferred":
		case "paused":
			return FG.warning;
		case "open":
			return FG.border;
		default:
			return FG.muted;
	}
}

export function formatIssueStatusStyled(status: unknown): string {
	return `${issueStatusColor(status)}${formatIssueStatus(status)}${RESET}`;
}

export function formatIssuePriority(priority: unknown): string {
	const text = priority == null ? "?" : String(priority);
	if (typeof priority !== "number" || !Number.isFinite(priority)) {
		return `${FG.muted}${text}${RESET}`;
	}
	if (priority <= 0) return `${BOLD}${FG.error}${text}${RESET}`;
	if (priority <= 1) return `${BOLD}${FG.warning}${text}${RESET}`;
	if (priority <= 2) return `${FG.accent}${text}${RESET}`;
	return `${FG.dim}${text}${RESET}`;
}

export function formatIssueScope(scope: unknown): string {
	const text = typeof scope === "string" ? scope.trim() : "";
	if (!text) return "";
	const normalized = text.toLowerCase();
	switch (normalized) {
		case "tiny":
		case "small":
			return `${FG.success}${text}${RESET}`;
		case "medium":
			return `${FG.accent}${text}${RESET}`;
		case "large":
			return `${FG.warning}${text}${RESET}`;
		case "xlarge":
			return `${BOLD}${FG.error}${text}${RESET}`;
		default:
			return `${FG.muted}${text}${RESET}`;
	}
}
