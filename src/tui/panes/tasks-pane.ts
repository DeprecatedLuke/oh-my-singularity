import type { AgentRegistry } from "../../agents/registry";
import type { AgentInfo, AgentStatus } from "../../agents/types";
import {
	UI_FLASH_DEBOUNCE_MS as FLASH_DEBOUNCE_MS,
	UI_FLASH_DURATION_MS as FLASH_DURATION_MS,
	HOURS_PER_DAY,
	LIMIT_TASK_TREE_RENDER_DEPTH,
	MS_PER_SECOND,
	SECONDS_PER_MINUTE,
} from "../../config/constants";
import type { TaskPollerLike } from "../../tasks/poller";
import type { TaskIssue } from "../../tasks/types";
import { agentFg, clipAnsi, FG, RESET, visibleWidth } from "../colors";
import { renderTaskTreeLines, type TaskTreeLine } from "../components/task-tree";
import { formatTokens } from "../utils/format";

type TerminalLike = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

export type Region = { x: number; y: number; width: number; height: number };

const TINT_HEARTBEAT = "\x1b[38;5;231m"; // white fg only
const DIM = FG.dim;

function agentStatusColor(status: string): string {
	switch (status) {
		case "spawning":
			return "\x1b[38;5;208m"; // orange
		case "running":
		case "working":
			return "\x1b[38;5;226m"; // yellow
		case "done":
			return "\x1b[38;5;82m"; // green
		case "failed":
		case "stuck":
		case "dead":
		case "aborted":
			return "\x1b[38;5;196m"; // red
		case "stopped":
			return "\x1b[38;5;245m"; // gray
		default:
			return "\x1b[38;5;245m"; // gray
	}
}

function isTerminalAgentStatus(status: AgentStatus | string): boolean {
	const normalized = String(status).toLowerCase();
	return (
		normalized === "done" ||
		normalized === "finished" ||
		normalized === "failed" ||
		normalized === "aborted" ||
		normalized === "stopped" ||
		normalized === "dead"
	);
}

function normalizeStateToken(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isClosedOrCompletedStatus(status: unknown): boolean {
	const normalized = normalizeStateToken(status);
	return normalized === "closed" || normalized === "completed" || normalized === "complete" || normalized === "done";
}

function isOrphanCandidateAgentState(state: string): boolean {
	return state === "running" || state === "spawning" || state === "working";
}

function createSyntheticIssue(id: string, title: string): TaskIssue {
	return {
		id,
		title,
		description: null,
		acceptance_criteria: null,
		status: "open",
		priority: 0,
		issue_type: "task",
		labels: [],
		assignee: null,
		created_at: "",
		updated_at: "",
	};
}

const ORPHAN_SECTION_ISSUE = createSyntheticIssue("__oms_orphan_agents__", "Orphaned agents");

type OrphanedAgent = {
	agent: AgentInfo;
	reason: string;
	taskIssue: TaskIssue | null;
	agentIssue: TaskIssue | null;
};

function classifyOrphanAgent(agent: AgentInfo, issueById: ReadonlyMap<string, TaskIssue>): OrphanedAgent | null {
	if (!agent.tasksAgentId || !agent.tasksAgentId.trim()) return null;

	const agentIssue = issueById.get(agent.tasksAgentId) ?? null;
	const stateSource = (agentIssue as any)?.agent_state ?? agent.status;
	const agentState = normalizeStateToken(stateSource);
	if (!isOrphanCandidateAgentState(agentState)) return null;

	if (!agent.taskId || !agent.taskId.trim()) {
		return {
			agent,
			reason: "no task",
			taskIssue: null,
			agentIssue,
		};
	}

	const taskIssue = issueById.get(agent.taskId) ?? null;
	if (!taskIssue) {
		return {
			agent,
			reason: "task missing",
			taskIssue: null,
			agentIssue,
		};
	}

	if (isClosedOrCompletedStatus(taskIssue.status)) {
		return {
			agent,
			reason: `task ${String(taskIssue.status)}`,
			taskIssue,
			agentIssue,
		};
	}

	return null;
}

export class TasksPane {
	readonly #poller: TaskPollerLike;
	readonly #registry?: AgentRegistry;
	readonly #onDirty?: () => void;
	readonly #onSelectAgent?: (agentRegistryId: string) => void;

	/** Issue-only lines (no agent children). Rebuilt on issues-changed. */
	#issueLines: TaskTreeLine[] = [];
	/** Effective lines: issue lines + interleaved agent children. Rebuilt before render. */
	#lines: TaskTreeLine[] = [];
	#scrollOffset = 0;
	#selectedIndex = 0;

	/** Selection key for preserving position across rebuilds. */
	#selectionKey: { type: "issue"; id: string } | { type: "agent"; id: string } | null = null;

	/** Hide closed by default. */
	#showClosed = false;
	#showDoneAgents = true;

	#lastRegionHeight = 0;
	readonly #lastEventCounts = new Map<string, number>();
	readonly #heartbeatAt = new Map<string, number>();
	#flashTimer: Timer | null = null;

	#cachedRegistryGeneration = -1;
	#cachedIssueLinesRef: TaskTreeLine[] | null = null;
	#cachedShowDoneAgents = true;
	#cachedLinesRefreshAt = 0;
	#issueRebuildPending = false;

	constructor(opts: {
		poller: TaskPollerLike;
		registry?: AgentRegistry;
		onDirty?: () => void;
		onSelectAgent?: (agentRegistryId: string) => void;
	}) {
		this.#poller = opts.poller;
		this.#registry = opts.registry;
		this.#onDirty = opts.onDirty;
		this.#onSelectAgent = opts.onSelectAgent;

		this.#poller.on("issues-changed", () => {
			if (this.#issueRebuildPending) return;
			this.#issueRebuildPending = true;
			queueMicrotask(() => {
				this.#issueRebuildPending = false;
				this.#rebuildIssueTree(this.#poller.issuesSnapshot);
			});
		});

		this.#rebuildIssueTree(this.#poller.issuesSnapshot);
	}

	toggleShowClosed(): void {
		this.#showClosed = !this.#showClosed;
		this.#rebuildIssueTree(this.#poller.issuesSnapshot);
	}

	toggleShowDoneAgents(): void {
		this.#showDoneAgents = !this.#showDoneAgents;
		this.#refreshEffectiveLines();
		this.#onDirty?.();
	}

	getSelectedIssueId(): string | null {
		return this.#lines[this.#selectedIndex]?.issue?.id ?? null;
	}

	getSelectedIssue(): TaskIssue | null {
		return this.#lines[this.#selectedIndex]?.issue ?? null;
	}

	getSelectedAgentId(): string | null {
		return this.#lines[this.#selectedIndex]?.agentId ?? null;
	}

	isSelectedAgentOrphaned(): boolean {
		return this.#lines[this.#selectedIndex]?.orphaned === true;
	}

	moveSelection(delta: number): void {
		if (delta === 0) return;
		if (this.#lines.length === 0) return;

		const next = Math.max(0, Math.min(this.#lines.length - 1, this.#selectedIndex + delta));
		if (next === this.#selectedIndex) return;

		this.#selectedIndex = next;
		this.#updateSelectionKey();
		this.#ensureSelectionVisible();
		this.#onDirty?.();

		// If the new selection is an agent line, notify for focus switch.
		const line = this.#lines[this.#selectedIndex];
		if (line?.agentId) {
			this.#onSelectAgent?.(line.agentId);
		}
	}

	scroll(delta: number): void {
		if (delta === 0) return;
		const maxOffset = Math.max(0, this.#lines.length - 1);
		this.#scrollOffset = Math.max(0, Math.min(maxOffset, this.#scrollOffset + delta));
		this.#onDirty?.();
	}

	handleMouse(name: string, _data: any, _region: Region): boolean {
		const dir = name === "MOUSE_WHEEL_UP" ? -1 : name === "MOUSE_WHEEL_DOWN" ? 1 : 0;
		if (!dir) return false;
		this.moveSelection(dir);
		return true;
	}

	render(term: TerminalLike, region: Region): void {
		const visibleHeight = Math.max(0, region.height);
		const width = Math.max(0, region.width);

		this.#lastRegionHeight = visibleHeight;

		// Refresh agent sub-nodes on every render (agents change independently of issues).
		this.#refreshEffectiveLines();
		this.#ensureSelectionVisible();
		this.#detectHeartbeats();

		if (visibleHeight <= 0 || width <= 0) return;

		if (this.#lines.length === 0) {
			const line1 = this.#showClosed ? "Nothing to do" : "Nothing to do (closed hidden)";
			for (let row = 0; row < visibleHeight; row += 1) {
				const text = row === 0 ? line1 : "";
				term.moveTo(region.x, region.y + row);
				term(clipPad(text, width));
			}
			return;
		}

		for (let row = 0; row < visibleHeight; row += 1) {
			const idx = this.#scrollOffset + row;
			const line = this.#lines[idx];
			const raw = line?.text ?? "";

			let text: string;
			if (width >= 2) {
				const marker = idx === this.#selectedIndex ? "> " : "  ";
				text = marker + composeTaskLineText(raw, line?.taskUsageBadge, width - 2);
			} else {
				text = clipWithEllipsis(idx === this.#selectedIndex ? ">" : " ", width);
			}

			const padded = clipPad(text, width);

			// Apply ANSI color for agent lines.
			let finalText: string;
			if (line?.agentId && line.agentStatus) {
				const terminal = isTerminalAgentStatus(line.agentStatus);
				const heartbeatActive = this.#isHeartbeatActive(line.agentId);
				const color = line.orphaned
					? FG.warning
					: terminal
						? DIM
						: line.agentRole
							? agentFg(line.agentRole)
							: agentStatusColor(line.agentStatus);
				const rendered =
					heartbeatActive && !line.orphaned && !terminal ? flashActivityIndicator(padded, color) : padded;
				const withMutedPipes = tintPipes(rendered, color);
				finalText = `${color}${withMutedPipes}${RESET}`;
			} else if (line?.dim) {
				finalText = `${DIM}${padded}${RESET}`;
			} else {
				finalText = padded;
			}

			term.moveTo(region.x, region.y + row);
			term(finalText);
		}
		this.#scheduleFlashClear();
	}

	/** Rebuild issue-only lines from a fresh issue snapshot. */
	#rebuildIssueTree(issues: readonly TaskIssue[]): void {
		this.#updateSelectionKey();

		const visibleIssues = this.#showClosed
			? issues
			: issues.filter(
					i => !isClosedOrCompletedStatus(i.status) || (this.#registry?.getByTask(i.id).length ?? 0) > 0,
				);

		this.#issueLines = renderTaskTreeLines(visibleIssues, LIMIT_TASK_TREE_RENDER_DEPTH);
		this.#refreshEffectiveLines();
		this.#onDirty?.();
	}

	/**
	 * Recompute effective lines (issues + agent children) from current issueLines
	 * and the live registry state. Preserves selection by key.
	 */
	#refreshEffectiveLines(): void {
		this.#updateSelectionKey();
		const currentGen = this.#registry?.generation ?? -1;
		const now = Date.now();
		const stale = now - this.#cachedLinesRefreshAt > 1000;
		if (
			this.#cachedIssueLinesRef === this.#issueLines &&
			this.#cachedRegistryGeneration === currentGen &&
			this.#cachedShowDoneAgents === this.#showDoneAgents &&
			!stale
		) {
			return;
		}
		const newLines: TaskTreeLine[] = [];
		const issueById = new Map<string, TaskIssue>();
		for (const issue of this.#poller.issuesSnapshot) {
			issueById.set(issue.id, issue);
		}
		const orphanedByAgentId = new Map<string, OrphanedAgent>();
		if (this.#registry) {
			for (const agent of this.#registry.getActive()) {
				const orphaned = classifyOrphanAgent(agent, issueById);
				if (!orphaned) continue;
				orphanedByAgentId.set(agent.id, orphaned);
			}
		}
		for (const issueLine of this.#issueLines) {
			const allAgents = this.#registry ? this.#registry.getByTask(issueLine.issue.id) : [];
			const taskUsageBadge = formatTaskUsageBadge(allAgents);

			newLines.push(taskUsageBadge ? { ...issueLine, taskUsageBadge } : issueLine);
			if (!this.#registry) continue;
			const active = allAgents.filter(a => !isTerminalAgentStatus(a.status) && !orphanedByAgentId.has(a.id));
			const terminal = allAgents
				.filter(a => isTerminalAgentStatus(a.status))
				.sort((a, b) => b.lastActivity - a.lastActivity || b.spawnedAt - a.spawnedAt);

			// Active agents first, then terminal (if shown).
			const visible = this.#showDoneAgents ? [...active, ...terminal] : active;

			for (const agent of visible) {
				const indent = "   ".repeat(issueLine.depth + 1);
				const roleLabel = agent.role === "designer-worker" ? "designer" : agent.role;
				const isTerminal = isTerminalAgentStatus(agent.status);
				const isError = agent.status === "failed" || agent.status === "aborted" || agent.status === "dead";
				const icon = isTerminal ? (isError ? "✘" : "◦") : "⦿";
				const usage = agent.usage;
				const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				const hasUsage =
					usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || total > 0;
				const tk = (n: number) => formatTokens(n).padStart(4);
				let usageSuffix = hasUsage
					? ` ↓${tk(usage.input)} ↑${tk(usage.output)} R${tk(usage.cacheRead)} W${tk(usage.cacheWrite)} T${tk(total)} ${formatCompactUsd(usage.cost)}`
					: "";
				const ctxWindow = agent.contextWindow ?? 0;
				const ctxTokens = agent.contextTokens ?? 0;
				if (ctxWindow > 0) {
					usageSuffix += ` C${String(Math.max(0, Math.min(999, Math.round((ctxTokens / ctxWindow) * 100)))).padStart(3, " ")}%`;
				} else if (ctxTokens > 0) {
					usageSuffix += ` ctx:${formatTokens(ctxTokens)}`;
				}
				const endTs = isTerminal ? agent.lastActivity : Date.now();
				const startTs = Number.isFinite(agent.spawnedAt) ? agent.spawnedAt : endTs;
				usageSuffix += ` T${formatCompactDuration(Math.max(0, endTs - startTs))}`;
				const compactions = agent.compactionCount ?? 0;
				if (compactions > 0) {
					usageSuffix += ` C:${compactions}`;
				}
				const statusDisplay = agent.status === "working" ? "active" : String(agent.status);
				const text = `${indent}${icon} ${roleLabel.padEnd(10)} |${centerPad(statusDisplay, 8)}|${usageSuffix}`;

				newLines.push({
					issue: issueLine.issue,
					agentId: agent.id,
					agentStatus: agent.status,
					agentRole: agent.role,
					depth: issueLine.depth + 1,
					text,
				});
			}

			if (!this.#showDoneAgents && terminal.length > 0) {
				const indent = "   ".repeat(issueLine.depth + 1);
				const noun = terminal.length === 1 ? "agent" : "agents";
				const text = `${indent}◌ ${terminal.length} done ${noun} hidden`;

				newLines.push({
					issue: issueLine.issue,
					depth: issueLine.depth + 1,
					text,
					dim: true,
				});
			}
		}
		if (orphanedByAgentId.size > 0) {
			const count = orphanedByAgentId.size;
			const noun = count === 1 ? "agent" : "agents";
			const orphaned = [...orphanedByAgentId.values()].sort((a, b) => b.agent.lastActivity - a.agent.lastActivity);
			const headerIssue = orphaned[0]?.agentIssue ?? orphaned[0]?.taskIssue ?? ORPHAN_SECTION_ISSUE;
			newLines.push({
				issue: headerIssue,
				depth: 0,
				text: `⚠ ${count} orphaned ${noun}`,
			});
			for (const entry of orphaned) {
				const { agent, reason, taskIssue, agentIssue } = entry;
				const roleLabel = agent.role === "designer-worker" ? "designer" : agent.role;
				const text = `   ⚠ ${roleLabel} |${agent.status}| (${reason})`;
				newLines.push({
					issue: agentIssue ?? taskIssue ?? ORPHAN_SECTION_ISSUE,
					agentId: agent.id,
					agentStatus: agent.status,
					agentRole: agent.role,
					depth: 1,
					text,
					orphaned: true,
				});
			}
		}
		this.#lines = newLines;
		this.#cachedRegistryGeneration = currentGen;
		this.#cachedIssueLinesRef = this.#issueLines;
		this.#cachedShowDoneAgents = this.#showDoneAgents;
		this.#cachedLinesRefreshAt = now;
		this.#restoreSelection();
	}

	/** Capture the current selection as a persistent key. */
	#updateSelectionKey(): void {
		const line = this.#lines[this.#selectedIndex];
		if (!line) {
			this.#selectionKey = null;
			return;
		}

		if (line.agentId) {
			this.#selectionKey = { type: "agent", id: line.agentId };
		} else {
			this.#selectionKey = { type: "issue", id: line.issue.id };
		}
	}

	/** Restore selectedIndex from selectionKey after lines change. */
	#restoreSelection(): void {
		if (!this.#selectionKey || this.#lines.length === 0) {
			this.#selectedIndex = Math.max(0, Math.min(Math.max(0, this.#lines.length - 1), this.#selectedIndex));
			this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, Math.max(0, this.#lines.length - 1)));
			this.#ensureSelectionVisible();
			return;
		}

		let nextIndex = -1;
		if (this.#selectionKey.type === "agent") {
			nextIndex = this.#lines.findIndex(l => l.agentId === this.#selectionKey!.id);
		} else {
			nextIndex = this.#lines.findIndex(l => !l.agentId && l.issue.id === this.#selectionKey!.id);
		}

		if (nextIndex >= 0) {
			this.#selectedIndex = nextIndex;
		} else {
			this.#selectedIndex = Math.max(0, Math.min(Math.max(0, this.#lines.length - 1), this.#selectedIndex));
		}

		this.#scrollOffset = Math.max(0, Math.min(this.#scrollOffset, Math.max(0, this.#lines.length - 1)));
		this.#ensureSelectionVisible();
	}

	#ensureSelectionVisible(): void {
		const height = this.#lastRegionHeight > 0 ? this.#lastRegionHeight : 1;

		const minVisible = this.#scrollOffset;
		const maxVisible = this.#scrollOffset + Math.max(0, height - 1);

		if (this.#selectedIndex < minVisible) {
			this.#scrollOffset = this.#selectedIndex;
			return;
		}

		if (this.#selectedIndex > maxVisible) {
			this.#scrollOffset = Math.max(0, this.#selectedIndex - height + 1);
		}
	}

	/** Compare event counts to detect new activity; record heartbeat timestamps. */
	#detectHeartbeats(): void {
		if (!this.#registry) return;
		const agents = this.#registry.getActive();
		const now = Date.now();
		for (const agent of agents) {
			const prevCount = this.#lastEventCounts.get(agent.id) ?? 0;
			const currentCount = agent.events.length;
			if (currentCount > prevCount) {
				const lastBeat = this.#heartbeatAt.get(agent.id) ?? 0;
				if (now - lastBeat >= FLASH_DEBOUNCE_MS) {
					this.#heartbeatAt.set(agent.id, now);
				}
				this.#lastEventCounts.set(agent.id, currentCount);
			}
		}
	}

	/** Check if an agent currently has an active heartbeat flash. */
	#isHeartbeatActive(agentId: string): boolean {
		const lastBeat = this.#heartbeatAt.get(agentId) ?? 0;
		return lastBeat > 0 && Date.now() - lastBeat < FLASH_DURATION_MS;
	}

	/** If any heartbeat flash is still active, schedule a single redraw when the earliest one expires. */
	#scheduleFlashClear(): void {
		if (this.#flashTimer) {
			clearTimeout(this.#flashTimer);
			this.#flashTimer = null;
		}
		const now = Date.now();
		let earliestExpiry = Infinity;
		for (const [, lastBeat] of this.#heartbeatAt) {
			if (lastBeat > 0) {
				const expiry = lastBeat + FLASH_DURATION_MS;
				if (expiry > now && expiry < earliestExpiry) {
					earliestExpiry = expiry;
				}
			}
		}
		if (earliestExpiry < Infinity) {
			const delay = Math.max(16, earliestExpiry - now);
			this.#flashTimer = setTimeout(() => {
				this.#flashTimer = null;
				this.#onDirty?.();
			}, delay);
		}
	}
}

function formatTaskUsageBadge(agents: readonly AgentInfo[]): string | undefined {
	if (agents.length === 0) return undefined;

	let totalTokens = 0;
	let cost = 0;
	let earliestSpawnedAt = Infinity;
	let latestLastActivity = -Infinity;
	let hasActiveAgent = false;
	for (const agent of agents) {
		const usage = agent.usage;
		totalTokens += usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		cost += usage.cost;
		if (Number.isFinite(agent.spawnedAt)) earliestSpawnedAt = Math.min(earliestSpawnedAt, agent.spawnedAt);
		if (Number.isFinite(agent.lastActivity)) latestLastActivity = Math.max(latestLastActivity, agent.lastActivity);
		if (!isTerminalAgentStatus(agent.status)) hasActiveAgent = true;
	}
	if (totalTokens <= 0 && cost <= 0) return undefined;
	const endTs = hasActiveAgent ? Date.now() : Number.isFinite(latestLastActivity) ? latestLastActivity : Date.now();
	const startTs = Number.isFinite(earliestSpawnedAt) ? earliestSpawnedAt : endTs;
	const elapsedMs = Math.max(0, endTs - startTs);
	return `${FG.dim}|${RESET} ${formatTokens(totalTokens)} ${formatCompactUsd(cost)} T${formatCompactDuration(elapsedMs)}`;
}

function composeTaskLineText(base: string, badge: string | undefined, width: number): string {
	if (width <= 0) return "";
	if (!badge) return clipWithEllipsis(base, width);

	const baseWidth = visibleWidth(base);
	const badgeWidth = visibleWidth(badge);
	if (baseWidth + badgeWidth + 1 <= width) {
		return `${base} ${badge}`;
	}

	if (badgeWidth >= width) {
		return clipWithEllipsis(badge, width);
	}

	const availableBaseWidth = width - badgeWidth - 1;
	if (availableBaseWidth <= 0) {
		return clipWithEllipsis(badge, width);
	}
	return `${clipWithEllipsis(base, availableBaseWidth)} ${badge}`;
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

function formatCompactUsd(value: number): string {
	if (value <= 0) return "$0";
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(3)}`;
}

function clipWithEllipsis(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	return `${clipAnsi(text, width - 1)}…`;
}

function clipPad(text: string, width: number): string {
	if (width <= 0) return "";
	const widthNow = visibleWidth(text);
	if (widthNow > width) return clipAnsi(text, width);
	if (widthNow < width) return text + " ".repeat(width - widthNow);
	return text;
}

function tintPipes(text: string, baseColor: string): string {
	if (!text.includes("|")) return text;
	return text.replace(/\|/g, `${FG.dim}|${baseColor}`);
}

function flashActivityIndicator(text: string, baseColor: string): string {
	const index = text.indexOf("⦿");
	if (index < 0) return text;
	return `${text.slice(0, index)}${TINT_HEARTBEAT}⦿${RESET}${baseColor}${text.slice(index + 1)}`;
}

function centerPad(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	const gap = width - text.length;
	const left = Math.floor(gap / 2);
	return " ".repeat(left) + text + " ".repeat(gap - left);
}
