import type { AgentRegistry } from "../../agents/registry";
import type { AgentInfo } from "../../agents/types";
import {
	HOURS_PER_DAY,
	MS_PER_SECOND,
	SECONDS_PER_DAY,
	SECONDS_PER_HOUR,
	SECONDS_PER_MINUTE,
	UI_SCROLL_STEP_LINES,
} from "../../config/constants";
import type { TaskStoreClient } from "../../tasks/client";
import type { TaskIssue } from "../../tasks/types";
import { asRecord } from "../../utils";
import { clipAnsi, visibleWidth } from "../colors";
import { renderMarkdownLines } from "../components/markdown";
import { formatTokens } from "../utils/format";
import type { TasksPane } from "./tasks-pane";

type TerminalLike = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

export type Region = { x: number; y: number; width: number; height: number };

type TaskUsageSummary = {
	agentCount: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

type PersistedAgentUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
};

type PersistedAgentSnapshot = {
	id: string;
	role: string;
	status: string;
	spawnedAt: number;
	lastActivity: number;
	usage: PersistedAgentUsage;
};

export class TasksDetailsPane {
	readonly #tasksClient: TaskStoreClient;
	readonly #tasksPane: TasksPane;
	readonly #registry?: AgentRegistry;
	readonly #onDirty?: () => void;

	#selectedId: string | null = null;
	#selectedIssue: TaskIssue | null = null;
	#selectedError: string | null = null;
	#fetchSeq = 0;
	#selectedPersistedAgents: PersistedAgentSnapshot[] = [];

	#scrollTop = 0;
	#lastMaxScrollTop = 0;

	constructor(opts: {
		tasksClient: TaskStoreClient;
		tasksPane: TasksPane;
		registry?: AgentRegistry;
		onDirty?: () => void;
	}) {
		this.#tasksClient = opts.tasksClient;
		this.#tasksPane = opts.tasksPane;
		this.#registry = opts.registry;
		this.#onDirty = opts.onDirty;
	}

	handleMouse(name: string, _data: any, _region: Region): boolean {
		const dir = name === "MOUSE_WHEEL_UP" ? -1 : name === "MOUSE_WHEEL_DOWN" ? 1 : 0;
		if (!dir) return false;

		const step = UI_SCROLL_STEP_LINES;
		this.#scrollTop = Math.max(0, Math.min(this.#lastMaxScrollTop, this.#scrollTop + dir * step));
		this.#onDirty?.();
		return true;
	}

	render(term: TerminalLike, region: Region): void {
		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);
		if (width <= 0 || height <= 0) return;

		const id = this.#tasksPane.getSelectedIssueId();
		const selectedFromTasksPane = this.#tasksPane.getSelectedIssue();
		if (id !== this.#selectedId) {
			this.#selectedId = id;
			this.#selectedIssue = null;
			this.#selectedError = null;
			this.#scrollTop = 0;
			this.#selectedPersistedAgents = [];

			if (id) {
				void this.#fetchSelectedIssue(id);
			}
		}

		if (id && selectedFromTasksPane && selectedFromTasksPane.id === id) {
			if (
				!this.#selectedIssue ||
				taskIssueSnapshotKey(this.#selectedIssue) !== taskIssueSnapshotKey(selectedFromTasksPane)
			) {
				this.#selectedIssue = selectedFromTasksPane;
				this.#selectedError = null;
			}
		}

		const lines: string[] = [];

		if (!id) {
			lines.push("No selection");
			lines.push("Use Shift+Alt+↑/↓ to select");
		} else if (this.#selectedError) {
			lines.push(`Error loading ${id}`);
			lines.push(this.#selectedError);
		} else if (!this.#selectedIssue) {
			lines.push(`Loading ${id}…`);
		} else {
			const issue = this.#selectedIssue;
			lines.push(issue.id);
			lines.push(issue.title);
			lines.push(`status: ${formatIssueStatus(issue.status)}  prio: ${String(issue.priority ?? "?")}`);
			const assignee = issue.assignee ? `assignee: ${issue.assignee}` : "assignee: (none)";
			lines.push(assignee);
			if (issue.labels?.length) {
				lines.push(`labels: ${issue.labels.join(", ")}`);
			}
			const liveAgents = this.#registry?.getByTask(issue.id) ?? [];
			const persistedAgents = this.#selectedPersistedAgents;
			const durationMs = computeTaskDurationMs(liveAgents, persistedAgents);
			if (durationMs != null) {
				lines.push(`task duration: ${formatVerboseDuration(durationMs)}`);
			}
			const usage = this.#getTaskUsageSummary(issue.id, issue, persistedAgents);
			if (usage) {
				lines.push(
					`agent usage: ${usage.agentCount}  ↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)}  total:${formatTokens(usage.totalTokens)}`,
				);
				if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
					lines.push(`cache: R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}`);
				}
				lines.push(`cost: ${formatUsd(usage.cost)}`);
			}
			const agentLines = buildAgentBreakdownLines(liveAgents, persistedAgents);
			if (agentLines.length > 0) {
				lines.push("");
				lines.push("── Agents ──");
				lines.push(...agentLines);
			}
			const desc = typeof issue.description === "string" ? issue.description.trim() : "";
			if (desc) {
				lines.push("");
				lines.push("── Description ──");
				for (const line of renderMarkdownLines(desc, width)) {
					lines.push(line);
				}
			}
			const ac = typeof issue.acceptance_criteria === "string" ? issue.acceptance_criteria.trim() : "";
			if (ac) {
				lines.push("");
				lines.push("── Acceptance Criteria ──");
				for (const line of renderMarkdownLines(ac, width)) {
					lines.push(line);
				}
			}

			const comments = Array.isArray(issue.comments) ? issue.comments : [];
			if (comments.length === 0) {
				lines.push("");
				lines.push("comments: (none)");
			} else {
				lines.push("");
				lines.push(`comments: ${comments.length}`);
				const recent = comments.slice(-Math.min(10, comments.length));
				for (const c of recent) {
					const when = typeof c.created_at === "string" ? renderRelativeTime(c.created_at) : "";
					const author = typeof c.author === "string" ? c.author : "";
					lines.push(`- ${author} ${when}`.trim());
					const text = typeof c.text === "string" ? c.text.trim() : "";
					if (!text) continue;
					const indent = width >= 2 ? "  " : "";
					const commentWidth = Math.max(1, width - indent.length);
					for (const line of renderMarkdownLines(text, commentWidth)) {
						lines.push(`${indent}${line}`);
					}
				}
			}
		}

		this.#lastMaxScrollTop = Math.max(0, lines.length - height);
		this.#scrollTop = Math.max(0, Math.min(this.#lastMaxScrollTop, this.#scrollTop));

		const visible = lines.slice(this.#scrollTop, this.#scrollTop + height);

		for (let row = 0; row < height; row += 1) {
			const text = visible[row] ?? "";
			term.moveTo(region.x, region.y + row);
			term(clipPadAnsi(text, width));
		}
	}

	#getTaskUsageSummary(
		taskId: string,
		issue: TaskIssue,
		persistedAgents: readonly PersistedAgentSnapshot[],
	): TaskUsageSummary | null {
		if (this.#registry) {
			const agents = this.#registry.getByTask(taskId);
			if (agents.length > 0) {
				const out: TaskUsageSummary = {
					agentCount: agents.length,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: 0,
				};
				for (const agent of agents) {
					const usage = agent.usage;
					out.input += usage.input;
					out.output += usage.output;
					out.cacheRead += usage.cacheRead;
					out.cacheWrite += usage.cacheWrite;
					out.totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
					out.cost += usage.cost;
				}
				return out;
			}
		}

		if (persistedAgents.length > 0) {
			const out: TaskUsageSummary = {
				agentCount: persistedAgents.length,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: 0,
			};
			for (const agent of persistedAgents) {
				const usage = agent.usage;
				out.input += usage.input;
				out.output += usage.output;
				out.cacheRead += usage.cacheRead;
				out.cacheWrite += usage.cacheWrite;
				out.totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				out.cost += usage.cost;
			}
			return out;
		}

		const issueRec = asRecord(issue);
		const usage = readStoredUsage(issueRec ? issueRec.usage_totals : null);
		if (
			usage.totalTokens <= 0 &&
			usage.input <= 0 &&
			usage.output <= 0 &&
			usage.cacheRead <= 0 &&
			usage.cacheWrite <= 0 &&
			usage.cost <= 0
		) {
			return null;
		}
		return {
			agentCount: 0,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			cost: usage.cost,
		};
	}
	async #fetchSelectedIssue(id: string): Promise<void> {
		const seq = ++this.#fetchSeq;
		try {
			const [issue, persistedAgents] = await Promise.all([
				this.#tasksClient.show(id),
				loadPersistedTaskAgents(this.#tasksClient, id),
			]);
			if (seq !== this.#fetchSeq) return;
			if (this.#selectedId !== id) return;
			this.#selectedIssue = issue;
			this.#selectedPersistedAgents = persistedAgents;
			this.#selectedError = null;
			this.#onDirty?.();
		} catch (err) {
			if (seq !== this.#fetchSeq) return;
			if (this.#selectedId !== id) return;
			const message = err instanceof Error ? err.message : String(err);
			this.#selectedIssue = null;
			this.#selectedPersistedAgents = [];
			this.#selectedError = message;
			this.#onDirty?.();
		}
	}
}

function renderRelativeTime(iso: string): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return iso;
	const delta = Date.now() - ms;
	const s = Math.floor(delta / MS_PER_SECOND);
	const m = Math.floor(s / SECONDS_PER_MINUTE);
	const h = Math.floor(s / SECONDS_PER_HOUR);
	const d = Math.floor(s / SECONDS_PER_DAY);
	if (d > 0) return `${d}d ago`;
	if (h > 0) return `${h}h ago`;
	if (m > 0) return `${m}m ago`;
	return `${Math.max(0, s)}s ago`;
}

function formatIssueStatus(status: unknown): string {
	return typeof status === "string" ? status : "(unknown)";
}

function taskIssueSnapshotKey(issue: TaskIssue): string {
	const commentsCount = Array.isArray(issue.comments) ? issue.comments.length : 0;
	return `${issue.id}|${issue.updated_at}|${String(issue.status ?? "")}|${commentsCount}`;
}

function formatUsd(value: number): string {
	if (value <= 0) return "$0.000";
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(3)}`;
}

function computeTaskDurationMs(
	liveAgents: readonly AgentInfo[],
	persistedAgents: readonly PersistedAgentSnapshot[],
): number | null {
	const starts = [
		...liveAgents.map(agent => (Number.isFinite(agent.spawnedAt) ? agent.spawnedAt : 0)).filter(value => value > 0),
		...persistedAgents
			.map(agent => (Number.isFinite(agent.spawnedAt) ? agent.spawnedAt : 0))
			.filter(value => value > 0),
	];
	const ends = [
		...liveAgents
			.map(agent => (Number.isFinite(agent.lastActivity) ? agent.lastActivity : 0))
			.filter(value => value > 0),
		...persistedAgents
			.map(agent => (Number.isFinite(agent.lastActivity) ? agent.lastActivity : 0))
			.filter(value => value > 0),
	];
	if (starts.length === 0 || ends.length === 0) return null;
	const startedAt = Math.min(...starts);
	let endedAt = Math.max(...ends);
	if (liveAgents.some(agent => !isTerminalAgentStatus(agent.status))) {
		endedAt = Math.max(endedAt, Date.now());
	}
	return Math.max(0, endedAt - startedAt);
}

function formatVerboseDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSeconds = Math.floor(ms / MS_PER_SECOND);
	const days = Math.floor(totalSeconds / SECONDS_PER_DAY);
	const hours = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
	const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	const seconds = totalSeconds % SECONDS_PER_MINUTE;

	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0 || days > 0) parts.push(`${hours}h`);
	if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(" ");
}

function buildAgentBreakdownLines(
	liveAgents: readonly AgentInfo[],
	persistedAgents: readonly PersistedAgentSnapshot[],
): string[] {
	const lines: string[] = [];
	const seenPersistedIds = new Set<string>();
	const sortedLiveAgents = [...liveAgents].sort(
		(a, b) => b.lastActivity - a.lastActivity || b.spawnedAt - a.spawnedAt,
	);
	for (const agent of sortedLiveAgents) {
		lines.push(formatAgentCostBreakdown(agent));
		if (agent.tasksAgentId) seenPersistedIds.add(agent.tasksAgentId);
		seenPersistedIds.add(agent.id);
	}
	const sortedPersistedAgents = [...persistedAgents].sort(
		(a, b) => b.lastActivity - a.lastActivity || b.spawnedAt - a.spawnedAt,
	);
	for (const agent of sortedPersistedAgents) {
		if (seenPersistedIds.has(agent.id)) continue;
		lines.push(formatPersistedAgentCostBreakdown(agent));
	}
	return lines;
}

function formatPersistedAgentCostBreakdown(agent: PersistedAgentSnapshot): string {
	const usage = agent.usage;
	const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const tk = (n: number) => formatTokens(n).padStart(4);
	const runtimeMs = Math.max(0, agent.lastActivity - agent.spawnedAt);
	return (
		`${agent.role.padEnd(10)} |${centerPad(String(agent.status), 8)}|` +
		` ↓${tk(usage.input)} ↑${tk(usage.output)} R${tk(usage.cacheRead)} W${tk(usage.cacheWrite)} T${tk(total)} ${formatUsd(usage.cost)}` +
		` T${formatCompactDuration(runtimeMs)}`
	);
}

async function loadPersistedTaskAgents(
	tasksClient: TaskStoreClient,
	taskId: string,
): Promise<PersistedAgentSnapshot[]> {
	try {
		const issues = await tasksClient.list(["--all", "--type", "agent"]);
		const snapshots = issues
			.filter(issue => getIssueTaskBinding(issue) === taskId)
			.map(issue => {
				const issueRec = asRecord(issue) ?? {};
				const usage = readStoredUsage(issueRec.usage_totals);
				const spawnedAt = parseTimestampMs(issue.created_at);
				const lastActivity =
					parseTimestampMs(issueRec.last_activity) ||
					parseTimestampMs(issue.updated_at) ||
					parseTimestampMs(issue.created_at);
				const status = (
					typeof issueRec.agent_state === "string" ? issueRec.agent_state : String(issue.status ?? "unknown")
				).trim();
				return {
					id: issue.id,
					role: inferPersistedAgentRole(issue),
					status: status || "unknown",
					spawnedAt: spawnedAt || lastActivity,
					lastActivity,
					usage,
				} satisfies PersistedAgentSnapshot;
			});
		snapshots.sort((a, b) => b.lastActivity - a.lastActivity || b.spawnedAt - a.spawnedAt);
		return snapshots;
	} catch {
		return [];
	}
}

function getIssueTaskBinding(issue: TaskIssue): string | null {
	const issueRec = asRecord(issue);
	if (!issueRec) return null;
	const hookTask = typeof issueRec.hook_task === "string" ? issueRec.hook_task.trim() : "";
	if (hookTask) return hookTask;
	const slotBindings = asRecord(issueRec.slot_bindings);
	const hookSlot = slotBindings && typeof slotBindings.hook === "string" ? slotBindings.hook.trim() : "";
	return hookSlot || null;
}

function inferPersistedAgentRole(issue: TaskIssue): string {
	const title = typeof issue.title === "string" ? issue.title.trim().toLowerCase() : "";
	if (title.startsWith("designer-worker-")) return "designer";
	if (title.startsWith("worker-")) return "worker";
	if (title.startsWith("issuer-")) return "issuer";
	if (title.startsWith("finisher-")) return "finisher";
	if (title.startsWith("steering-") || title.startsWith("resolver-") || title.startsWith("broadcast-steering-")) {
		return "steering";
	}
	if (title.startsWith("singularity-")) return "singularity";
	return "worker";
}

function readStoredUsage(value: unknown): PersistedAgentUsage {
	const usageRec = asRecord(value) ?? {};
	const input = toNonNegativeNumber(usageRec.input);
	const output = toNonNegativeNumber(usageRec.output);
	const cacheRead = toNonNegativeNumber(usageRec.cacheRead);
	const cacheWrite = toNonNegativeNumber(usageRec.cacheWrite);
	const totalTokens = toNonNegativeNumber(usageRec.totalTokens) || input + output + cacheRead + cacheWrite;
	const cost = toNonNegativeNumber(usageRec.cost);
	return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

function parseTimestampMs(value: unknown): number {
	if (typeof value !== "string") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function toNonNegativeNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return value > 0 ? value : 0;
}

function formatAgentCostBreakdown(agent: AgentInfo): string {
	const roleLabel = agent.role === "designer-worker" ? "designer" : agent.role;
	const usage = agent.usage;
	const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const tk = (n: number) => formatTokens(n).padStart(4);
	let line =
		`${roleLabel.padEnd(10)} |${centerPad(String(agent.status), 8)}|` +
		` ↓${tk(usage.input)} ↑${tk(usage.output)} R${tk(usage.cacheRead)} W${tk(usage.cacheWrite)} T${tk(total)} ${formatUsd(usage.cost)}`;

	const ctxWindow = agent.contextWindow ?? 0;
	const ctxTokens = agent.contextTokens ?? 0;
	if (ctxWindow > 0) {
		const pct = Math.max(0, Math.min(999, Math.round((ctxTokens / ctxWindow) * 100)));
		line += ` C${String(pct).padStart(3, " ")}%`;
	} else if (ctxTokens > 0) {
		line += ` ctx:${formatTokens(ctxTokens)}`;
	}

	const endTs = isTerminalAgentStatus(agent.status) ? agent.lastActivity : Date.now();
	const startTs = Number.isFinite(agent.spawnedAt) ? agent.spawnedAt : endTs;
	line += ` T${formatCompactDuration(Math.max(0, endTs - startTs))}`;

	const compactions = agent.compactionCount ?? 0;
	if (compactions > 0) line += ` C:${compactions}`;
	return line;
}

function formatCompactDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return " 0s";
	const seconds = Math.floor(ms / MS_PER_SECOND);
	if (seconds < 100) return `${seconds}s`.padStart(3, " ");
	const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
	if (minutes < 100) return `${minutes}m`.padStart(3, " ");
	const hours = Math.floor(minutes / SECONDS_PER_MINUTE);
	if (hours < 100) return `${hours}h`.padStart(3, " ");
	const days = Math.floor(hours / HOURS_PER_DAY);
	if (days < 100) return `${days}d`.padStart(3, " ");
	return "99d";
}

function isTerminalAgentStatus(status: unknown): boolean {
	const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
	return (
		normalized === "done" ||
		normalized === "failed" ||
		normalized === "aborted" ||
		normalized === "stopped" ||
		normalized === "dead"
	);
}

function centerPad(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	const gap = width - text.length;
	const left = Math.floor(gap / 2);
	return " ".repeat(left) + text + " ".repeat(gap - left);
}

function clipPadAnsi(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = clipAnsi(text, width);
	const vw = visibleWidth(clipped);
	if (vw >= width) return `${clipped}\x1b[0m`;
	return `${clipped}\x1b[0m${" ".repeat(width - vw)}`;
}
