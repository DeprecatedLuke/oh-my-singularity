import { truncateToWidth } from "@oh-my-pi/pi-natives";
import { wrapLine } from "../../tui/components/text-formatter";
import type {
	ToolRenderCallOptions,
	ToolRenderComponent,
	ToolRenderResultOptions,
	ToolResultWithError,
	ToolTheme,
} from "./types";

const MAX_ARG_PREVIEW = 80;
const COLLAPSED_LINES = 3;
const EXPANDED_LINES = 20;
const BODY_INDENT = "  ";

/**
 * renderCall: status icon + tool label + key args.
 *
 * - Streaming: header line + per-arg body lines.
 * - Non-streaming: concise one-line header.
 */
export function renderToolCall(
	toolLabel: string,
	args: string[],
	theme: ToolTheme,
	options?: ToolRenderCallOptions,
): ToolRenderComponent {
	const title = theme.fg("toolTitle", theme.bold ? theme.bold(toolLabel) : toolLabel);
	const separator = theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ";
	const visibleArgs = args.map(arg => arg.trim()).filter(Boolean);
	return {
		render(width: number): string[] {
			const isStreaming = options?.isPartial === true;
			const hasResult = Boolean(options?.result);
			const status = isStreaming
				? "running"
				: hasResult
					? options?.result?.isError === true
						? "error"
						: "success"
					: "pending";
			const icon = styledIcon(status, theme, options?.spinnerFrame);
			const header = `${icon} ${title}`;
			if (isStreaming && visibleArgs.length > 0) {
				const lines = [truncateToWidth(header, width)];
				const wrappedWidth = Math.max(1, width - BODY_INDENT.length);
				for (const arg of visibleArgs) {
					const wrapped = wrapLine(arg, wrappedWidth);
					if (wrapped.length === 0) continue;
					for (const line of wrapped) {
						lines.push(truncateToWidth(`${BODY_INDENT}${theme.fg("muted", line)}`, width));
					}
				}
				return lines;
			}

			const resultSummary = extractSummaryLine(options?.result);
			const previewText = resultSummary || visibleArgs.join(separator);
			const preview = truncateToWidth(previewText, MAX_ARG_PREVIEW);
			const summaryScope = options?.result?.isError === true ? "error" : "muted";
			const suffix = preview ? `${separator}${theme.fg(summaryScope, preview)}` : "";
			return [truncateToWidth(`${header}${suffix}`, width)];
		},
	};
}

/**
 * renderResult: expandable body lines only.
 */
export function renderToolResult(
	_toolLabel: string,
	result: ToolResultWithError,
	options: ToolRenderResultOptions,
	theme: ToolTheme,
): ToolRenderComponent {
	const isError = result.isError === true;
	const allLines = extractTextLines(result);
	const maxBody = options.expanded ? EXPANDED_LINES : COLLAPSED_LINES;
	const visibleBody = allLines.slice(0, maxBody);
	const hasMore = allLines.length > maxBody;

	return {
		render(width: number): string[] {
			const lines: string[] = [];
			const wrappedWidth = Math.max(1, width - BODY_INDENT.length);
			for (const line of visibleBody) {
				const wrapped = wrapLine(line, wrappedWidth);
				if (wrapped.length === 0) {
					lines.push(truncateToWidth(BODY_INDENT, width));
					continue;
				}
				for (const bodyLine of wrapped) {
					lines.push(
						truncateToWidth(`${BODY_INDENT}${theme.fg(isError ? "error" : "toolOutput", bodyLine)}`, width),
					);
				}
			}
			if (!options.expanded && hasMore) {
				lines.push(truncateToWidth(`${BODY_INDENT}${theme.fg("dim", "(Ctrl+O for more)")}`, width));
			}
			return lines;
		},
	};
}

function styledIcon(
	status: "success" | "error" | "pending" | "running",
	theme: ToolTheme,
	spinnerFrame?: number,
): string {
	if (status === "running" && Array.isArray(theme.spinnerFrames) && typeof spinnerFrame === "number") {
		return theme.spinnerFrames[spinnerFrame % theme.spinnerFrames.length] ?? "…";
	}
	if (theme.styledSymbol) {
		const map: Record<string, [string, string]> = {
			success: ["status.success", "success"],
			error: ["status.error", "error"],
			pending: ["status.pending", "muted"],
			running: ["status.running", "accent"],
		};
		const entry = map[status];
		if (entry) return theme.styledSymbol(entry[0], entry[1]);
	}
	switch (status) {
		case "success":
			return "✓";
		case "error":
			return "✗";
		case "pending":
			return "…";
		case "running":
			return "⏳";
	}
}

function extractTextLines(result: ToolResultWithError): string[] {
	const content = result.content;
	if (!Array.isArray(content)) return [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			return block.text.split("\n").map(l => l.trimEnd());
		}
	}
	return [];
}

function extractSummaryLine(result: ToolResultWithError | undefined): string {
	if (!result) return "";
	const lines = extractTextLines(result);
	for (const line of lines) {
		const normalized = line.trim();
		if (normalized.length > 0) return normalized;
	}
	return "";
}
