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
	if (!rec) return typeof result === "string" ? sanitizeRenderableText(tryFormatJson(result) ?? result) : "";
	const content = Array.isArray(rec.content) ? rec.content : [];
	const parts: string[] = [];
	for (const item of content) {
		const r = asRecord(item);
		if (r && r.type === "text" && typeof r.text === "string")
			parts.push(sanitizeRenderableText(tryFormatJson(r.text) ?? r.text));
	}
	return parts.join("\n");
}

export function formatToolResultPreview(value: unknown, max = 200): string {
	if (typeof value === "string") {
		const normalized = sanitizeRenderableText(value);
		return tryFormatJson(normalized) ?? previewValue(normalized, max);
	}
	if (value && typeof value === "object") {
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
	if (displayText) {
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
