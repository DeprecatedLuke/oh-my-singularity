import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { makeTasksExtension } from "./tasks-tool";
import type { ExtensionAPI, UnknownRecord } from "./types";

export const WORKER_TASK_ALLOWED_ACTIONS = [
	"show",
	"list",
	"search",
	"ready",
	"comments",
	"comment_add",
	"query",
	"dep_tree",
	"types",
];

const NO_CHANGES_NEEDED_RE =
	/\b(?:task already complete|already complete|already done|already satisfies|already satisfied|no changes needed|no code changes needed|no implementation changes|no edits required|nothing to change|upstream already implemented)\b/i;
const STRONG_IMPLEMENTATION_VERB_RE = /\b(?:implemented|added|updated|fixed|created|wrote|patched|refactored)\b/i;
const IMPLEMENTATION_CLAIM_RE =
	/\b(?:implemented|added|updated|modified|changed|fixed|created|wrote|patched|refactored)\b/i;
const COMPLETION_SIGNAL_RE =
	/\b(?:completion|what changed|changed files?|verification|verified|remaining risk|remaining blocker)\b/i;
const IMPLEMENTATION_CONTEXT_RE = /\b(?:verified|verification|test(?:ed|s)?|risk|blocker|summary)\b/i;
const COMMENT_LINE_RE = /^(?:\/\/|#|\/\*|\*|\*\/)/;
const TRIVIAL_CONTENT_LINE_RE =
	/^(?:use\s+[^;]+;|import\s+.+;|export\s+\{[^}]*\}\s+from\s+.+;|export\s+\*\s+from\s+.+;|from\s+\S+\s+import\s+.+|mod\s+\w+;|pub\s+mod\s+\w+;|package\s+[A-Za-z0-9_.]+;|namespace\s+[A-Za-z0-9_.]+;)\s*$/;

type Fingerprint =
	| { kind: "invalid" }
	| { kind: "missing" }
	| { kind: "error" }
	| { kind: "other"; size: number }
	| { kind: "file"; size: number; hash: string };

type GitStatusResult = {
	paths: Set<string>;
	error: string | null;
};

type DetectChangedOptions = {
	repoRoot: string;
	baselinePaths: Set<string>;
	baselineFingerprints: Map<string, Fingerprint>;
	currentPaths: Set<string>;
	claimedPaths: string[];
	writeIntentPaths: Set<string>;
};

type BuildRejectionReasonOptions = {
	claimedPaths: string[];
	writeIntentCount: number;
	changedPaths: string[];
	gitStatusError: string | null;
};

export async function registerTasksWorkerHooks(api: ExtensionAPI, role = "worker"): Promise<void> {
	const registerTasksTool = makeTasksExtension({
		role,
		allowedActions: WORKER_TASK_ALLOWED_ACTIONS,
	});
	await registerTasksTool(api);

	const repoRoot = process.cwd();
	const baselineStatus = await getGitStatusPaths(api, repoRoot);
	const baselineFingerprints = snapshotFingerprints(repoRoot, baselineStatus.paths);
	const writeIntentPaths = new Set<string>();

	api.on("tool_call", async event => {
		const toolName = typeof event?.toolName === "string" ? event.toolName : "";
		const input = asRecord(event?.input ?? event?.args);
		if (toolName === "edit" || toolName === "write") {
			const relPath = normalizeRepoPath(typeof input?.path === "string" ? input.path : "", repoRoot);
			if (relPath) {
				if (!baselineFingerprints.has(relPath)) {
					baselineFingerprints.set(relPath, fingerprintPath(repoRoot, relPath));
				}
				writeIntentPaths.add(relPath);
			}
			return;
		}

		if (toolName !== "tasks") return;

		const action = typeof input?.action === "string" ? input.action.trim() : "";
		if (action !== "comment_add") return;
		const text = typeof input?.text === "string" ? input.text.trim() : "";
		if (!text) return;
		const claimType = classifyCommentClaim(text);
		if (claimType === "non_completion") return;
		if (claimType === "no_changes_needed") return;

		const claimedPaths = extractClaimedPaths(text, repoRoot);
		const currentStatus = await getGitStatusPaths(api, repoRoot);
		const changedPaths = detectChangedPaths({
			repoRoot,
			baselinePaths: baselineStatus.paths,
			baselineFingerprints,
			currentPaths: currentStatus.paths,
			claimedPaths,
			writeIntentPaths,
		});

		const evidencePaths =
			claimedPaths.length > 0 ? claimedPaths : writeIntentPaths.size > 0 ? [...writeIntentPaths] : [];

		const candidatePaths =
			evidencePaths.length > 0 ? evidencePaths.filter(relPath => changedPaths.has(relPath)) : [...changedPaths];

		const substantivePaths = candidatePaths.filter(relPath => hasSubstantiveFileContent(repoRoot, relPath));

		if (substantivePaths.length > 0) return;

		return {
			block: true,
			reason: buildRejectionReason({
				claimedPaths,
				writeIntentCount: writeIntentPaths.size,
				changedPaths: [...changedPaths],
				gitStatusError: currentStatus.error,
			}),
		};
	});
}

export default async function tasksWorkerExtension(api: ExtensionAPI): Promise<void> {
	await registerTasksWorkerHooks(api, "worker");
}

function asRecord(value: unknown): UnknownRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as UnknownRecord;
}

function classifyCommentClaim(text: string): "no_changes_needed" | "implementation_claim" | "non_completion" {
	if (NO_CHANGES_NEEDED_RE.test(text) && !STRONG_IMPLEMENTATION_VERB_RE.test(text)) {
		return "no_changes_needed";
	}

	if (COMPLETION_SIGNAL_RE.test(text)) return "implementation_claim";
	if (IMPLEMENTATION_CLAIM_RE.test(text) && IMPLEMENTATION_CONTEXT_RE.test(text)) {
		return "implementation_claim";
	}

	return "non_completion";
}

function extractClaimedPaths(text: string, repoRoot: string): string[] {
	const paths = new Set<string>();

	const backtickPathRe = /`([^`\n]+)`/g;
	let match = backtickPathRe.exec(text);
	while (match) {
		const candidate = match[1] ?? "";
		const relPath = normalizeRepoPath(candidate, repoRoot);
		if (relPath) paths.add(relPath);
		match = backtickPathRe.exec(text);
	}

	const barePathRe = /(?:^|[\s(])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_.-]+)?)/g;
	match = barePathRe.exec(text);
	while (match) {
		const candidate = match[1] ?? "";
		const relPath = normalizeRepoPath(candidate, repoRoot);
		if (relPath) paths.add(relPath);
		match = barePathRe.exec(text);
	}

	return [...paths];
}

function normalizeRepoPath(rawPath: string, repoRoot: string): string | null {
	if (typeof rawPath !== "string") return null;

	let value = rawPath.trim();
	if (!value) return null;

	if (value.startsWith('"') && value.endsWith('"')) {
		try {
			value = JSON.parse(value);
		} catch {
			value = value.slice(1, -1);
		}
	}

	value = value
		.replace(/^`+|`+$/g, "")
		.replace(/^'+|'+$/g, "")
		.replace(/^"+|"+$/g, "")
		.replace(/[),.;:]+$/g, "")
		.trim();

	if (!value) return null;

	value = value.replace(/^\.\//, "");

	const absPath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
	const rootWithSep = repoRoot.endsWith(path.sep) ? repoRoot : `${repoRoot}${path.sep}`;
	if (absPath !== repoRoot && !absPath.startsWith(rootWithSep)) return null;

	const relPath = path.relative(repoRoot, absPath).split(path.sep).join("/");
	if (!relPath || relPath === ".") return null;

	return relPath;
}

async function getGitStatusPaths(api: ExtensionAPI, repoRoot: string): Promise<GitStatusResult> {
	const exec = api.exec;
	if (typeof exec !== "function") {
		return { paths: new Set(), error: "exec unavailable" };
	}

	try {
		const res = await exec("git", ["status", "--porcelain", "--untracked-files=all"], { timeout: 10_000 });

		if (!res || typeof res !== "object") {
			return { paths: new Set(), error: "git status returned no data" };
		}

		if (res.code !== 0) {
			const stderr = typeof res.stderr === "string" ? res.stderr.trim() : "";
			const stdout = typeof res.stdout === "string" ? res.stdout.trim() : "";
			return {
				paths: new Set(),
				error: stderr || stdout || `git status exited ${res.code}`,
			};
		}

		const stdout = typeof res.stdout === "string" ? res.stdout : "";
		return { paths: parseGitStatusPaths(stdout, repoRoot), error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { paths: new Set(), error: message };
	}
}

function parseGitStatusPaths(stdout: string, repoRoot: string): Set<string> {
	const paths = new Set<string>();
	const lines = stdout.split(/\r?\n/);

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();
		if (!line || line.length < 4) continue;

		const rawPath = line.slice(3).trim();
		if (!rawPath) continue;

		if (rawPath.includes(" -> ")) {
			const split = rawPath.split(" -> ");
			const fromPath = split[0] ?? "";
			const toPath = split[1] ?? "";
			const before = normalizeRepoPath(fromPath, repoRoot);
			const after = normalizeRepoPath(toPath, repoRoot);
			if (before) paths.add(before);
			if (after) paths.add(after);
			continue;
		}

		const relPath = normalizeRepoPath(rawPath, repoRoot);
		if (relPath) paths.add(relPath);
	}

	return paths;
}

function snapshotFingerprints(repoRoot: string, paths: Set<string>): Map<string, Fingerprint> {
	const out = new Map<string, Fingerprint>();
	for (const relPath of paths) {
		out.set(relPath, fingerprintPath(repoRoot, relPath));
	}
	return out;
}

function fingerprintPath(repoRoot: string, relPath: string): Fingerprint {
	const normalized = normalizeRepoPath(relPath, repoRoot);
	if (!normalized) return { kind: "invalid" };

	const absPath = path.resolve(repoRoot, normalized);

	try {
		const stat = fs.statSync(absPath);
		if (!stat.isFile()) {
			return { kind: "other", size: stat.size };
		}

		const bytes = fs.readFileSync(absPath);
		const hash = crypto.createHash("sha1").update(bytes).digest("hex");
		return { kind: "file", size: stat.size, hash };
	} catch (err) {
		if (isEnoent(err)) return { kind: "missing" };
		return { kind: "error" };
	}
}

function isEnoent(err: unknown): boolean {
	const rec = asRecord(err);
	return !!rec && rec.code === "ENOENT";
}

function fingerprintsEqual(a: Fingerprint | undefined, b: Fingerprint | undefined): boolean {
	if (!a || !b) return false;
	if (a.kind !== b.kind) return false;

	if (a.kind === "file" && b.kind === "file") {
		return a.size === b.size && a.hash === b.hash;
	}

	if (a.kind === "other" && b.kind === "other") {
		return a.size === b.size;
	}

	return true;
}

function detectChangedPaths(opts: DetectChangedOptions): Set<string> {
	const allPaths = new Set<string>([
		...opts.currentPaths,
		...opts.baselinePaths,
		...opts.claimedPaths,
		...opts.writeIntentPaths,
	]);

	const changedPaths = new Set<string>();

	for (const relPath of allPaths) {
		if (opts.baselineFingerprints.has(relPath)) {
			const before = opts.baselineFingerprints.get(relPath);
			const after = fingerprintPath(opts.repoRoot, relPath);
			if (!fingerprintsEqual(before, after)) changedPaths.add(relPath);
			continue;
		}

		if (opts.currentPaths.has(relPath)) {
			changedPaths.add(relPath);
		}
	}

	return changedPaths;
}

function hasSubstantiveFileContent(repoRoot: string, relPath: string): boolean {
	const normalized = normalizeRepoPath(relPath, repoRoot);
	if (!normalized) return false;

	const absPath = path.resolve(repoRoot, normalized);

	try {
		const stat = fs.statSync(absPath);
		if (!stat.isFile() || stat.size === 0) return false;

		const content = fs.readFileSync(absPath, "utf8");
		const meaningfulLines = content
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.filter(line => !COMMENT_LINE_RE.test(line));

		if (meaningfulLines.length === 0) return false;

		return meaningfulLines.some(line => !TRIVIAL_CONTENT_LINE_RE.test(line));
	} catch {
		return false;
	}
}

function buildRejectionReason(opts: BuildRejectionReasonOptions): string {
	const details: string[] = [];

	if (opts.claimedPaths.length > 0) {
		details.push(`claimed_paths=${opts.claimedPaths.join(", ")}`);
	}

	if (opts.writeIntentCount > 0) {
		details.push(`edit_write_calls=${opts.writeIntentCount}`);
	}

	if (opts.changedPaths.length > 0) {
		const preview = opts.changedPaths.slice(0, 8).join(", ");
		details.push(`changed_paths_seen=${preview}`);
	}

	if (opts.gitStatusError) {
		details.push(`git_status_error=${opts.gitStatusError}`);
	}

	const detailText = details.length > 0 ? ` (${details.join("; ")})` : "";

	return (
		"Completion rejected: implementation was claimed, but no substantive file changes were verified for this run" +
		detailText +
		'. If this task is already complete, explicitly report "task already complete, no changes needed". Otherwise, implement code changes and include changed file paths in your completion comment.'
	);
}
