import type { AgentRegistry } from "../../agents/registry";
import type { AgentInfo } from "../../agents/types";
import { UI_SCROLL_STEP_LINES } from "../../config/constants";
import { clipAnsi as clipAnsiColor, visibleWidth } from "../colors";
import { getRenderedRpcLines } from "../components/rpc-renderer";
import { formatTokens } from "../utils/format";

type TerminalLike = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

export type Region = { x: number; y: number; width: number; height: number };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceActiveAgentId(state: unknown): string | null {
	if (!state || typeof state !== "object" || Array.isArray(state)) return null;
	const rec = state as { activeAgentId?: unknown };
	return typeof rec.activeAgentId === "string" ? rec.activeAgentId : null;
}

function formatIdentityPath(agent: AgentInfo): string {
	if (agent.id === "oms:system") return "OMS/system";
	return `OMS/${agent.id.replace(/:/g, "/")}`;
}

function shortenModel(model: string): string {
	let m = model;
	const slash = m.lastIndexOf("/");
	if (slash >= 0) m = m.slice(slash + 1);
	if (m.startsWith("claude-")) m = m.slice(7);
	m = m.replace(/-\d{8,}$/, "");
	return m;
}

function formatUsd(value: number): string {
	if (value <= 0) return "$0.000";
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(3)}`;
}

function formatUsageSummary(agent: AgentInfo, width: number): string {
	const usage = agent.usage;
	const total = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (total <= 0) return "";
	const dim = "\x1b[38;2;95;102;115m"; // FG.dim
	const accent = "\x1b[38;2;254;188;56m"; // FG.accent
	const muted = "\x1b[38;2;119;125;136m"; // FG.muted
	const rst = "\x1b[0m";
	let summary = `${dim}\u2191${rst}${muted}${formatTokens(usage.input)}${rst} ${dim}\u2193${rst}${muted}${formatTokens(usage.output)}${rst} ${dim}total${rst} ${accent}${formatTokens(total)}${rst} ${dim}cost${rst} ${accent}${formatUsd(usage.cost)}${rst}`;
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		summary += ` ${dim}cache${rst} ${muted}R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}${rst}`;
	}
	// Center within width
	const plain = summary.replace(/\x1b\[[0-9;]*m/g, "");
	const pad = Math.max(0, width - plain.length);
	const left = Math.floor(pad / 2);
	return " ".repeat(left) + summary;
}

// ---------------------------------------------------------------------------
// AgentPane
// ---------------------------------------------------------------------------

export class AgentPane {
	readonly #registry: AgentRegistry;
	readonly #onDirty?: () => void;

	// Per-agent scroll state.
	readonly #scrollTopByAgentId = new Map<string, number>();
	readonly #followTailByAgentId = new Map<string, boolean>();

	// Cached rendered RPC lines to avoid O(n) recomputation every frame.
	#rpcLinesCache: {
		agentId: string;
		eventsLength: number;
		width: number;
		lines: string[];
	} | null = null;

	constructor(opts: { registry: AgentRegistry; onDirty?: () => void }) {
		this.#registry = opts.registry;
		this.#onDirty = opts.onDirty;
	}

	handleMouse(name: string, _data: any, region: Region, state?: unknown): boolean {
		const dir = name === "MOUSE_WHEEL_UP" ? -1 : name === "MOUSE_WHEEL_DOWN" ? 1 : 0;
		if (!dir) return false;

		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);
		if (width <= 0 || height <= 0) return false;

		const activeAgentId = coerceActiveAgentId(state);
		const active = activeAgentId ? this.#registry.get(activeAgentId) : undefined;
		if (!active) return false;

		const logHeight = Math.max(0, height - 1);
		if (logHeight <= 0) return false;
		const events = active.events ?? [];
		const renderedLines = this.#getCachedRpcLines(active.id, events, width);
		const maxScrollTop = Math.max(0, renderedLines.length - logHeight);
		const current = this.#getScrollTop(active.id, maxScrollTop);
		const step = UI_SCROLL_STEP_LINES;
		const next = Math.max(0, Math.min(maxScrollTop, current + dir * step));

		this.#scrollTopByAgentId.set(active.id, next);
		this.#followTailByAgentId.set(active.id, next === maxScrollTop);
		this.#onDirty?.();
		return true;
	}

	getTitle(state?: unknown): string {
		const activeAgentId = coerceActiveAgentId(state);
		const active = activeAgentId ? this.#registry.get(activeAgentId) : undefined;
		if (!active) return "Agents";

		let title = `Agents (${formatIdentityPath(active)})`;
		if (active.model) title += ` | ${shortenModel(active.model)}`;
		if (active.thinking) title += ` | thinking: ${active.thinking}`;
		const ctxWindow = active.contextWindow ?? 0;
		const ctxTokens = active.contextTokens ?? 0;
		if (ctxWindow > 0) {
			title += ` | C${Math.round((ctxTokens / ctxWindow) * 100)}%`;
		} else if (ctxTokens > 0) {
			title += ` | ctx: ${formatTokens(ctxTokens)}`;
		}
		const compactions = active.compactionCount ?? 0;
		if (compactions > 0) {
			title += ` | compactions: ${compactions}`;
		}
		return title;
	}

	render(term: TerminalLike, region: Region, state?: unknown): void {
		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);

		if (width <= 0 || height <= 0) return;

		const activeAgentId = coerceActiveAgentId(state);
		const active = activeAgentId ? this.#registry.get(activeAgentId) : undefined;

		// --- RPC log (selected agent) ---
		const headerRows = active ? 1 : 0;
		if (active) {
			term.moveTo(region.x, region.y);
			term(clipPadAnsi(formatUsageSummary(active, width), width));
		}

		const logY = region.y + headerRows;
		const logHeight = Math.max(0, height - headerRows);
		const events = active?.events ?? [];
		const renderedLines = this.#getCachedRpcLines(active?.id ?? "", events, width);
		let scrollTop = 0;
		if (active && logHeight > 0) {
			const maxScrollTop = Math.max(0, renderedLines.length - logHeight);
			scrollTop = this.#getScrollTop(active.id, maxScrollTop);
			this.#scrollTopByAgentId.set(active.id, scrollTop);
			this.#followTailByAgentId.set(active.id, scrollTop === maxScrollTop);
		}

		const contentLines = renderedLines.slice(scrollTop, scrollTop + logHeight);
		for (let row = 0; row < logHeight; row += 1) {
			term.moveTo(region.x, logY + row);
			term(clipPadAnsi(contentLines[row] ?? "", width));
		}
	}

	notifyDirty(): void {
		this.#onDirty?.();
	}

	#getCachedRpcLines(agentId: string, events: readonly unknown[], width: number): string[] {
		const c = this.#rpcLinesCache;
		if (c && c.agentId === agentId && c.eventsLength === events.length && c.width === width) {
			return c.lines;
		}
		const lines = getRenderedRpcLines(events, width);
		this.#rpcLinesCache = { agentId, eventsLength: events.length, width, lines };
		return lines;
	}

	#getScrollTop(agentId: string, maxScrollTop: number): number {
		const follow = this.#followTailByAgentId.get(agentId) ?? true;
		const stored = this.#scrollTopByAgentId.get(agentId);
		if (stored === undefined || follow) return maxScrollTop;
		return Math.max(0, Math.min(maxScrollTop, stored));
	}
}

// ---------------------------------------------------------------------------
// ANSI text utilities
// ---------------------------------------------------------------------------

function visibleLengthAnsi(text: string): number {
	return visibleWidth(text);
}

function clipAnsi(text: string, width: number): string {
	return clipAnsiColor(text, width);
}

function clipPadAnsi(text: string, width: number): string {
	if (width <= 0) return "";

	const clipped = clipAnsi(text, width);
	const visible = visibleLengthAnsi(clipped);

	if (visible >= width) return clipped;
	return clipped + " ".repeat(width - visible);
}
