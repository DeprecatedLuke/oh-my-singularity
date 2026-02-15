import { UI_AGENT_SUMMARY_MAX_CHARS } from "../../config/constants";
import { getCapabilities } from "../../core/capabilities";
import { asRecord, clipText, previewValue, squashWhitespace } from "../../utils";
import { agentFg, BOLD, FG, lifecycleFg, RESET, UNBOLD } from "../colors";
import { wrapLine } from "./text-formatter";

const AGENT_SUMMARY_MAX = UI_AGENT_SUMMARY_MAX_CHARS;

function detailValue(value: unknown, max = AGENT_SUMMARY_MAX): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return clipText(squashWhitespace(value), max);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return previewValue(value, max);
}

export function extractAgentRole(data: Record<string, unknown> | null): string | null {
	if (!data) return null;
	if (typeof data.role === "string" && data.role) return data.role;
	if (typeof data.agentId === "string" && data.agentId) {
		const seg = data.agentId.split(":")[0];
		if (seg) return seg;
	}
	return null;
}

export function extractLifecycle(data: Record<string, unknown> | null, message: string, level: string): string {
	if (data && typeof data.lifecycle === "string" && data.lifecycle) return data.lifecycle;
	const lower = message.toLowerCase();
	// Check "failed" before "started" so "spawn failed" → "failed"
	if (lower.includes("failed") || level === "error") return "failed";
	if (lower.includes("started") || lower.includes("requested spawn")) return "started";
	if (lower.includes("finished")) return "finished";
	if (lower.includes("paused")) return "paused";
	if (lower.includes("resumed")) return "resumed";
	if (lower.includes("stopped") || lower.includes("blocked")) return "stopped";
	if (lower.includes("interrupt")) return "interrupt";
	if (lower.includes("deferred")) return "deferred";
	if (lower.includes("skipped")) return "skipped";
	if (level === "warn") return "interrupt";
	return "";
}

export function parseStartedLifecycleMessage(
	message: string,
): { startedBy: string; agentId: string; context: string } | null {
	const marker = " started ";
	const markerIndex = message.indexOf(marker);
	if (markerIndex <= 0) return null;

	const startedBy = message.slice(0, markerIndex).trim();
	const rest = message.slice(markerIndex + marker.length).trim();
	if (!startedBy || !rest) return null;

	const withMarker = ' with "';
	const withIndex = rest.indexOf(withMarker);
	if (withIndex < 0) return { startedBy, agentId: rest, context: "" };

	const agentId = rest.slice(0, withIndex).trim();
	if (!agentId) return null;

	const tail = rest.slice(withIndex + withMarker.length);
	const context = tail.endsWith('"') ? tail.slice(0, -1).trim() : tail.trim();
	return { startedBy, agentId, context };
}

export function parseFinishedLifecycleMessage(message: string): { agentId: string; summary: string } | null {
	const marker = ' finished with "';
	const markerIndex = message.indexOf(marker);
	if (markerIndex <= 0) return null;

	const agentId = message.slice(0, markerIndex).trim();
	if (!agentId) return null;

	const tail = message.slice(markerIndex + marker.length);
	const summary = tail.endsWith('"') ? tail.slice(0, -1).trim() : tail.trim();
	return { agentId, summary };
}

export function parseSummaryRecord(summary: string): Record<string, unknown> | null {
	let candidate = summary.trim();
	if (!candidate) return null;

	for (let depth = 0; depth < 2; depth += 1) {
		if (!candidate.startsWith("{") && !candidate.startsWith('"')) return null;
		try {
			const parsed = JSON.parse(candidate);
			if (typeof parsed === "string") {
				candidate = parsed.trim();
				continue;
			}
			return asRecord(parsed);
		} catch {
			return null;
		}
	}

	return null;
}

export function summarySnippets(summary: string, maxLines = 3): string[] {
	const clean = squashWhitespace(summary);
	if (!clean) return [];
	const parts = clean
		.split(/\s*(?:\|\s+|;\s+|\. )\s*/)
		.map(part => part.trim())
		.filter(Boolean);
	const source = parts.length > 1 ? parts : [clean];
	return source.slice(0, maxLines).map(part => clipText(part, AGENT_SUMMARY_MAX));
}

export function formatAgentLogSummary(
	role: string,
	lifecycle: string,
	level: string,
	message: string,
	data: Record<string, unknown> | null,
): string {
	const safeMessage = message || level;
	const taskId = detailValue(data?.taskId) || "(none)";
	const dataAgentId = detailValue(data?.agentId);

	if (lifecycle === "started" && getCapabilities(role).rendering === "decision") {
		const started = parseStartedLifecycleMessage(safeMessage);
		const agentId = started?.agentId || dataAgentId || `${role}:?`;
		const context =
			detailValue(started?.context) ||
			detailValue(data?.context) ||
			clipText(squashWhitespace(safeMessage), AGENT_SUMMARY_MAX);
		return `start ${agentId} for ${taskId} — ${context}`;
	}

	if (lifecycle === "started" && getCapabilities(role).rendering === "implementation") {
		const started = parseStartedLifecycleMessage(safeMessage);
		const agentId = started?.agentId || dataAgentId || `${role}:?`;
		const context =
			detailValue(started?.context) ||
			detailValue(data?.context) ||
			clipText(squashWhitespace(safeMessage), AGENT_SUMMARY_MAX);
		return `start ${agentId} for ${taskId} — ${context}`;
	}
	if (lifecycle === "finished" && getCapabilities(role).rendering === "decision") {
		const finished = parseFinishedLifecycleMessage(safeMessage);
		const summary = finished?.summary || "";
		const decision = parseSummaryRecord(summary);
		const agentId = finished?.agentId || dataAgentId || `${role}:?`;
		const action = detailValue(decision?.action) || "finish";
		const decisionTask = detailValue(decision?.taskId) || taskId;
		const reason = detailValue(decision?.reason) || detailValue(data?.reason);
		const decisionMessage = detailValue(decision?.message) || detailValue(data?.message);
		const raw = summary && !decision ? clipText(squashWhitespace(summary), AGENT_SUMMARY_MAX) : "";
		const detail = reason || decisionMessage || raw || clipText(squashWhitespace(safeMessage), AGENT_SUMMARY_MAX);
		const detailWithRaw = raw && detail !== raw ? `${detail}; ${raw}` : detail;
		return `${action} ${agentId} for ${decisionTask} — ${detailWithRaw}`;
	}

	if (lifecycle === "finished" && getCapabilities(role).rendering === "implementation") {
		const finished = parseFinishedLifecycleMessage(safeMessage);
		const summary = finished?.summary || "";
		const snippets = summarySnippets(summary, 3);
		const agentId = finished?.agentId || dataAgentId || `${role}:?`;
		const changes = snippets.length > 0 ? snippets.join("; ") : "(no assistant output)";
		return `done ${agentId} for ${taskId} — ${changes}`;
	}

	return safeMessage;
}

export function formatDataBackedLogSummary(
	message: string,
	level: string,
	data: Record<string, unknown> | null,
): string {
	const safeMessage = message || level;
	if (!data) return safeMessage;

	const taskId = detailValue(data.taskId);
	if (!taskId) return safeMessage;

	const lower = safeMessage.toLowerCase();
	if (lower.includes("issuer skipped") || lower.includes("issuer deferred")) {
		const action = "skip";
		const reason = detailValue(data.reason) || clipText(squashWhitespace(safeMessage), AGENT_SUMMARY_MAX);
		return `${action} ${taskId} — ${reason}`;
	}

	if (lower.includes("broadcast steer") || lower.includes("broadcast interrupt")) {
		const action = "steer";
		const reason = detailValue(data.reason) || clipText(squashWhitespace(safeMessage), AGENT_SUMMARY_MAX);
		return `${action} ${taskId} — ${reason}`;
	}

	return safeMessage;
}

export const INLINE_TAG_RE = /^\[([^\]]+)\]\s*(.*)$/;
export const UPPER_SOURCE_TAG_RE = /^([A-Z][A-Z0-9_-]*):\s*(.*)$/;
export const TAG_GAP = 2;

export type TaggedText = {
	tag: string;
	message: string;
	tagColor: string;
	messageColor: string;
};

export type TaggedTextInput = {
	text: string;
	style: string;
	role?: string;
	lifecycle?: string;
	level?: string;
};

export type TaggedTextBlockInput = {
	kind: string;
	text?: string;
	style?: string;
	role?: string;
	lifecycle?: string;
	level?: string;
};

export function parseInlineTag(text: string): { tag: string; message: string } | null {
	const bracket = text.match(INLINE_TAG_RE);
	if (bracket) {
		const tag = (bracket[1] ?? "").trim();
		if (tag) return { tag, message: bracket[2] ?? "" };
	}
	const source = text.match(UPPER_SOURCE_TAG_RE);
	if (source) {
		const tag = (source[1] ?? "").trim();
		if (tag) return { tag, message: source[2] ?? "" };
	}
	return null;
}

export function deriveTaggedText(block: TaggedTextInput): TaggedText | null {
	if (block.style === "agentLog") {
		const role = (block.role ?? "").trim();
		if (!role) return null;
		const lifecycle = block.lifecycle ?? "";
		return {
			tag: role,
			message: block.text,
			tagColor: agentFg(role),
			messageColor: lifecycle ? lifecycleFg(lifecycle) : FG.dim,
		};
	}

	if (block.style !== "dim" && block.style !== "warn" && block.style !== "error") return null;

	const messageColor = block.style === "error" ? FG.error : block.style === "warn" ? FG.warning : FG.dim;

	const inline = parseInlineTag(block.text);
	if (inline) {
		return {
			tag: inline.tag,
			message: inline.message,
			tagColor: messageColor,
			messageColor,
		};
	}

	const level = typeof block.level === "string" ? block.level.trim().toLowerCase() : "";
	if (level === "debug") {
		return {
			tag: "DEBUG",
			message: block.text,
			tagColor: messageColor,
			messageColor,
		};
	}

	return null;
}

export function renderTaggedTextLines(
	tagged: TaggedText,
	width: number,
	tagContentWidth: number,
	tagGap = TAG_GAP,
): string[] {
	if (width <= 0 || tagContentWidth <= 0) return [];
	const paddedTag = tagged.tag.padEnd(tagContentWidth, " ");
	const tagPrefix = `${tagged.tagColor}${BOLD}[${paddedTag}]${UNBOLD}${RESET}${" ".repeat(tagGap)}`;
	const prefixWidth = tagContentWidth + 2 + tagGap;
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapLine(tagged.message, contentWidth);
	if (wrapped.length === 0) return [];
	const indent = " ".repeat(prefixWidth);
	return wrapped.map((line, i) => {
		const pre = i === 0 ? tagPrefix : indent;
		return `${pre}${tagged.messageColor}${line}${RESET}`;
	});
}

export function getMaxTaggedTextWidth(blocks: readonly TaggedTextBlockInput[]): number {
	let max = 0;
	for (const block of blocks) {
		if (block.kind !== "text" || typeof block.text !== "string" || typeof block.style !== "string") continue;
		const tagged = deriveTaggedText({
			text: block.text,
			style: block.style,
			role: block.role,
			lifecycle: block.lifecycle,
			level: block.level,
		});
		if (!tagged) continue;
		max = Math.max(max, tagged.tag.length);
	}
	return max;
}
