export interface InProgressIssue {
	id: string;
	labels?: readonly string[] | null;
}

export interface LabelConflictResult {
	conflicting: boolean;
	/** Sorted list of issue ids that conflict with the candidate. */
	conflictWith: string[];
	/** Sorted list of overlapping labels (deduped). */
	overlappingLabels: string[];
}

const CONFLICT_LABEL_PREFIXES = ["module:", "file:"] as const;

function isConflictLabel(label: string): boolean {
	return CONFLICT_LABEL_PREFIXES.some(prefix => label.startsWith(prefix));
}

function normalizeConflictLabels(labels: readonly string[] | null | undefined): string[] {
	if (!labels?.length) return [];

	const out = new Set<string>();
	for (const label of labels) {
		if (typeof label !== "string") continue;
		if (!isConflictLabel(label)) continue;
		out.add(label);
	}

	return [...out].sort();
}

export function checkLabelConflicts(
	candidateLabels: readonly string[] | null | undefined,
	inProgressIssues: readonly InProgressIssue[] | null | undefined,
): LabelConflictResult {
	const candidate = new Set(normalizeConflictLabels(candidateLabels));
	if (candidate.size === 0 || !inProgressIssues?.length) {
		return { conflicting: false, conflictWith: [], overlappingLabels: [] };
	}

	const conflictWith = new Set<string>();
	const overlappingLabels = new Set<string>();

	for (const issue of inProgressIssues) {
		if (!issue) continue;

		const issueConflictLabels = normalizeConflictLabels(issue.labels);
		let hasOverlap = false;

		for (const label of issueConflictLabels) {
			if (!candidate.has(label)) continue;
			overlappingLabels.add(label);
			hasOverlap = true;
		}

		if (hasOverlap) conflictWith.add(issue.id);
	}

	const conflictWithSorted = [...conflictWith].sort();
	const overlappingLabelsSorted = [...overlappingLabels].sort();

	return {
		conflicting: conflictWithSorted.length > 0,
		conflictWith: conflictWithSorted,
		overlappingLabels: overlappingLabelsSorted,
	};
}
