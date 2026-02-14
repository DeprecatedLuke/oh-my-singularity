import { UI_RESULT_MAX_LINES } from "../../config/constants";
import { asRecord, clipText, previewValue, squashWhitespace } from "../../utils";
import { BG, BOLD, BOX, clipAnsi, FG, ICON, RESET, RESET_FG, UNBOLD, visibleWidth } from "../colors";
import { sanitizeRenderableText, tryFormatJson, wrapLine } from "./text-formatter";

export type ToolBlock = {
	kind: "tool";
	toolName: string;
	argsPreview: string;
	resultPreview: string;
	/** Full text content extracted from result.content — used for rich rendering. */
	resultContent: string;
	state: "pending" | "success" | "error";
};

const CAP_LEN = 3;
export const RESULT_MAX_LINES = UI_RESULT_MAX_LINES;

/** Extract text content from an AgentToolResult-shaped object (result.content[].text). */
export function extractResultText(result: unknown): string {
	const rec = asRecord(result);
	if (!rec) {
		if (typeof result !== "string") return "";
		const normalized = sanitizeRenderableText(result);
		if (!normalized.trim()) return "";
		return sanitizeRenderableText(tryFormatJson(normalized) ?? normalized);
	}
	const content = Array.isArray(rec.content) ? rec.content : [];
	const parts: string[] = [];
	for (const item of content) {
		if (typeof item === "string") {
			const normalized = sanitizeRenderableText(item);
			if (normalized.trim()) parts.push(normalized);
			continue;
		}
		const r = asRecord(item);
		if (!r) continue;
		if (typeof r.text === "string") {
			const normalized = sanitizeRenderableText(tryFormatJson(r.text) ?? r.text);
			if (normalized.trim()) parts.push(normalized);
			continue;
		}
		if (typeof r.content === "string") {
			const normalized = sanitizeRenderableText(tryFormatJson(r.content) ?? r.content);
			if (normalized.trim()) parts.push(normalized);
		}
	}
	const joined = parts.join("\n");
	return joined.trim() ? joined : "";
}

type ToolResultPreviewOptions = {
	toolName?: string;
	args?: unknown;
	isError?: boolean;
};

function getToolBaseName(toolName: string | undefined): string {
	return typeof toolName === "string" ? toolName.replace(/^proxy_/, "") : "";
}

function getTasksAction(result: unknown, args: unknown): string {
	const argsRec = asRecord(args);
	if (argsRec && typeof argsRec.action === "string" && argsRec.action.trim()) return argsRec.action.trim();
	const resultRec = asRecord(result);
	if (resultRec && typeof resultRec.action === "string" && resultRec.action.trim()) return resultRec.action.trim();
	const detailsRec = asRecord(resultRec?.details);
	if (detailsRec && typeof detailsRec.action === "string" && detailsRec.action.trim()) return detailsRec.action.trim();
	const text = extractResultText(result);
	const match = text.match(/\btasks\s+([a-z_]+)\s*:/i);
	return match?.[1]?.trim() ?? "";
}

function extractToolPayload(value: unknown): { record: Record<string, unknown> | null; payload: unknown } {
	const record = asRecord(value);
	if (!record) return { record: null, payload: value };
	if ("details" in record) return { record, payload: record.details };
	if ("data" in record) return { record, payload: record.data };
	return { record, payload: value };
}

function formatTasksResultPreview(value: unknown, args: unknown, isError: boolean): string {
	const action = getTasksAction(value, args);
	const label = action ? `tasks ${action}` : "tasks";
	const { record, payload } = extractToolPayload(value);
	const payloadRec = asRecord(payload);
	const argsRec = asRecord(args);
	const argTaskId = argsRec && typeof argsRec.id === "string" ? argsRec.id.trim() : "";
	if (isError) {
		const errorMessage =
			(typeof payloadRec?.error === "string" && payloadRec.error.trim()) ||
			(typeof record?.error === "string" && record.error.trim()) ||
			"request failed";
		return `${label}: ${errorMessage}`;
	}
	if (payload === null || payload === undefined) return `${label}: ok (no output)`;
	if (Array.isArray(payload)) {
		const count = payload.length;
		if (action === "list" || action === "search" || action === "ready") {
			return `Listed ${count} task${count === 1 ? "" : "s"}`;
		}
		if (action === "comments") return `Loaded ${count} comment${count === 1 ? "" : "s"}`;
		return `${label}: ${count} item${count === 1 ? "" : "s"}`;
	}
	if (payloadRec) {
		const id = typeof payloadRec.id === "string" && payloadRec.id.trim() ? payloadRec.id.trim() : argTaskId;
		if (action === "create" && id) return `Created task ${id}`;
		if (action === "show" && id) return `Loaded task ${id}`;
		if (action === "comment_add") return id ? `Added comment to ${id}` : "Added task comment";
		if (action === "update" && id) return `Updated task ${id}`;
		if (action === "close" && id) return `Closed task ${id}`;

		const collection = Array.isArray(payloadRec.tasks)
			? payloadRec.tasks
			: Array.isArray(payloadRec.issues)
				? payloadRec.issues
				: Array.isArray(payloadRec.results)
					? payloadRec.results
					: null;
		if (collection && (action === "list" || action === "search" || action === "ready")) {
			return `Listed ${collection.length} task${collection.length === 1 ? "" : "s"}`;
		}
		if (Array.isArray(payloadRec.comments) && action === "comments") {
			const count = payloadRec.comments.length;
			return `Loaded ${count} comment${count === 1 ? "" : "s"}`;
		}

		const summary = typeof payloadRec.summary === "string" ? payloadRec.summary.trim() : "";
		if (summary) return `${label}: ${summary}`;
		const message = typeof payloadRec.message === "string" ? payloadRec.message.trim() : "";
		if (message) return `${label}: ${message}`;
		if (id) return `${label}: ${id}`;
	}
	if (typeof payload === "string") {
		const normalized = sanitizeRenderableText(payload);
		if (normalized.trim()) return `${label}: ${squashWhitespace(normalized)}`;
	}
	return `${label}: ok`;
}

function formatStartTasksResultPreview(value: unknown, isError: boolean): string {
	const { record, payload } = extractToolPayload(value);
	const payloadRec = asRecord(payload);
	if (isError) {
		const errorMessage =
			(typeof payloadRec?.error === "string" && payloadRec.error.trim()) ||
			(typeof record?.error === "string" && record.error.trim()) ||
			"request failed";
		return `start_tasks failed: ${errorMessage}`;
	}
	if (payloadRec && payloadRec.ok === false) {
		const message =
			(typeof payloadRec.error === "string" && payloadRec.error.trim()) ||
			(typeof payloadRec.summary === "string" && payloadRec.summary.trim()) ||
			"request failed";
		return `start_tasks failed: ${message}`;
	}
	if (payloadRec) {
		const spawned =
			typeof payloadRec.spawned === "number" && Number.isFinite(payloadRec.spawned)
				? Math.trunc(payloadRec.spawned)
				: null;
		const taskIds =
			Array.isArray(payloadRec.taskIds) && payloadRec.taskIds.every(id => typeof id === "string")
				? (payloadRec.taskIds as string[])
				: [];
		if (spawned !== null && taskIds.length > 0) {
			return `Started task spawning (spawned=${spawned}): ${taskIds.slice(0, 3).join(", ")}`;
		}
		if (spawned !== null) return `Started task spawning (spawned=${spawned})`;
		const summary = typeof payloadRec.summary === "string" ? payloadRec.summary.trim() : "";
		if (summary) return summary;
		const message = typeof payloadRec.message === "string" ? payloadRec.message.trim() : "";
		if (message) return message;
	}
	if (payload === null || payload === undefined) return "Started task spawning";
	if (typeof payload === "string") {
		const normalized = sanitizeRenderableText(payload);
		if (normalized.trim()) return squashWhitespace(normalized);
	}
	return "Started task spawning";
}

export function formatToolResultPreview(value: unknown, max = 200, opts?: ToolResultPreviewOptions): string {
	const base = getToolBaseName(opts?.toolName);
	if (base === "tasks") return clipText(formatTasksResultPreview(value, opts?.args, opts?.isError === true), max);
	if (base === "start_tasks") return clipText(formatStartTasksResultPreview(value, opts?.isError === true), max);
	if (base === "wake" || base === "wakeup") return opts?.isError ? "wakeup failed" : "Sent wakeup signal";
	if (typeof value === "string") {
		const normalized = sanitizeRenderableText(value);
		if (!normalized.trim()) return "(no output)";
		return tryFormatJson(normalized) ?? previewValue(normalized, max);
	}

	if (value === null || value === undefined) return "(no output)";

	const rec = asRecord(value);
	if (rec) {
		const text = extractResultText(value);
		if (text) return tryFormatJson(text) ?? previewValue(text, max);

		if ("details" in rec) {
			if (rec.details === null || rec.details === undefined) return "(no output)";
			return formatToolResultPreview(rec.details, max);
		}
		if ("data" in rec) {
			if (rec.data === null || rec.data === undefined) return "(no output)";
			return formatToolResultPreview(rec.data, max);
		}

		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return previewValue(value, max);
		}
	}

	return previewValue(value, max);
}

/** Format tool args for header display, extracting the most useful field per tool type. */
export function formatToolArgs(toolName: string, args: unknown): string {
	const rec = asRecord(args);
	if (!rec) return previewValue(args, 80);
	const base = toolName.replace(/^proxy_/, "");
	switch (base) {
		case "read":
			return typeof rec.path === "string" ? rec.path : previewValue(args, 80);
		case "grep":
			return typeof rec.pattern === "string" ? rec.pattern : previewValue(args, 80);
		case "bash":
			return typeof rec.command === "string" ? clipText(squashWhitespace(rec.command), 80) : previewValue(args, 80);
		case "edit":
			return typeof rec.path === "string" ? rec.path : previewValue(args, 80);
		case "write":
			return typeof rec.path === "string" ? rec.path : previewValue(args, 80);
		case "find":
			return typeof rec.pattern === "string" ? rec.pattern : previewValue(args, 80);
		case "lsp":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "fetch":
			return typeof rec.url === "string" ? clipText(rec.url, 80) : previewValue(args, 80);
		case "web_search":
			return typeof rec.query === "string" ? rec.query : previewValue(args, 80);
		case "python":
			return "(code)";
		case "notebook":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "tasks":
			return typeof rec.action === "string" ? rec.action : previewValue(args, 80);
		case "task":
			return typeof rec.description === "string" ? clipText(rec.description, 80) : previewValue(args, 80);
		default:
			return previewValue(args, 80);
	}
}

export function renderToolBlockLines(block: ToolBlock, width: number): string[] {
	if (width < 8) return [];

	// State-based colors
	const borderFg = block.state === "error" ? FG.error : block.state === "pending" ? FG.accent : FG.dim;
	const bgAnsi = block.state === "error" ? BG.toolError : block.state === "pending" ? BG.toolPending : BG.toolSuccess;
	const icon = block.state === "error" ? ICON.error : block.state === "pending" ? ICON.pending : ICON.success;

	const bc = (text: string) => `${borderFg}${text}${RESET_FG}`;
	const cap = BOX.h.repeat(CAP_LEN);

	// ---- Header label ----
	const argsClipped = block.argsPreview ? clipText(block.argsPreview, Math.max(0, width - 25)) : "";
	const argsStr = argsClipped ? ` ${FG.dim}${ICON.dot}${RESET_FG} ${FG.dim}${argsClipped}${RESET_FG}` : "";
	const labelContent = `${icon} ${BOLD}${block.toolName}${UNBOLD}${argsStr}`;
	const rawLabelPadded = ` ${labelContent} `;

	// ---- Top bar ----
	const topLeftStr = bc(`${BOX.tl}${cap}`);
	const topRightStr = bc(BOX.tr);
	const topLeftVW = 1 + CAP_LEN;
	const topRightVW = 1;
	const labelMaxVW = Math.max(0, width - topLeftVW - topRightVW);
	const labelPadded = clipAnsi(rawLabelPadded, labelMaxVW);
	const labelVW = visibleWidth(labelPadded);
	const topFillCount = Math.max(0, width - topLeftVW - labelVW - topRightVW);
	const topLine = `${topLeftStr}${labelPadded}${bc(BOX.h.repeat(topFillCount))}${topRightStr}`;

	// ---- Content ----
	const prefixStr = bc(`${BOX.v} `);
	const suffixStr = bc(BOX.v);
	const prefixVW = 2;
	const suffixVW = 1;
	const contentWidth = Math.max(1, width - prefixVW - suffixVW);

	const contentLines: string[] = [];
	const rawText = block.resultContent || block.resultPreview;
	const displayText = rawText ? sanitizeRenderableText(tryFormatJson(rawText) ?? rawText) : "";
	if (displayText.trim()) {
		// Split by newlines first, then wrap each logical line
		const logicalLines = displayText.split(/\r?\n/);
		const allWrapped: string[] = [];
		for (const ll of logicalLines) {
			if (ll.length === 0) {
				allWrapped.push("");
			} else {
				allWrapped.push(...wrapLine(ll, contentWidth));
			}
		}
		const maxLines = RESULT_MAX_LINES;
		const isError = block.state === "error";
		const textColor = isError ? FG.error : FG.muted;
		for (const line of allWrapped.slice(0, maxLines)) {
			const clipped = clipAnsi(line, contentWidth);
			const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
			contentLines.push(`${prefixStr}${textColor}${clipped}${RESET_FG}${pad}${suffixStr}`);
		}
		if (allWrapped.length > maxLines) {
			const more = `… ${allWrapped.length - maxLines} more lines`;
			const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(more)));
			contentLines.push(`${prefixStr}${FG.dim}${more}${RESET_FG}${pad}${suffixStr}`);
		}
	} else {
		const fallback = block.state === "error" ? "(error; no output)" : "(no output)";
		const textColor = block.state === "error" ? FG.error : FG.dim;
		const clipped = clipAnsi(fallback, contentWidth);
		const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		contentLines.push(`${prefixStr}${textColor}${clipped}${RESET_FG}${pad}${suffixStr}`);
	}

	// ---- Bottom bar ----
	const bottomLeftStr = bc(`${BOX.bl}${cap}`);
	const bottomRightStr = bc(BOX.br);
	const bottomFillCount = Math.max(0, width - (1 + CAP_LEN) - 1);
	const bottomLine = `${bottomLeftStr}${bc(BOX.h.repeat(bottomFillCount))}${bottomRightStr}`;

	// ---- Apply background to all lines ----
	const allLines = [topLine, ...contentLines, bottomLine];
	return allLines.map(line => {
		const clipped = clipAnsi(line, width);
		const vw = visibleWidth(clipped);
		const pad = " ".repeat(Math.max(0, width - vw));
		return `${bgAnsi}${clipped}${pad}${RESET}`;
	});
}
