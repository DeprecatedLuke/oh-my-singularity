import { truncateToWidth } from "@oh-my-pi/pi-natives";
import { wrapLine } from "../../tui/components/text-formatter";
import type {
	ToolParams,
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
	toolLabel: string | (() => string),
	args: string[] | (() => string[]),
	theme: ToolTheme,
	options?: ToolRenderCallOptions,
): ToolRenderComponent {
	const separator = theme.sep?.dot ? ` ${theme.sep.dot} ` : " · ";
	const resolveArgs = () => {
		const resolved = typeof args === "function" ? args() : args;
		return resolved.map(arg => arg.trim()).filter(Boolean);
	};
	const makeTitle = () => {
		const resolved = typeof toolLabel === "function" ? toolLabel() : toolLabel;
		return theme.fg("toolTitle", theme.bold ? theme.bold(resolved) : resolved);
	};
	return {
		render(width: number): string[] {
			const hasResult = Boolean(options?.result);
			const isStreaming = !hasResult || options?.isPartial === true;
			const status =
				options?.isPartial === true
					? "running"
					: hasResult
						? options?.result?.isError === true
							? "error"
							: "success"
						: "pending";
			const icon = styledIcon(status, theme, options?.spinnerFrame);
			const header = `${icon} ${makeTitle()}`;
			const visibleArgs = resolveArgs();
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

			const argsPreview = visibleArgs.join(separator);
			const previewText = argsPreview || extractSummaryLine(options?.result);
			const preview = truncateToWidth(previewText, MAX_ARG_PREVIEW);
			const summaryScope = !argsPreview && options?.result?.isError === true ? "error" : "muted";
			const suffix = preview ? `${separator}${theme.fg(summaryScope, preview)}` : "";
			return [truncateToWidth(`${header}${suffix}`, width)];
		},
	};
}

/**
 * renderResult: expandable body lines only.
 * Short single-line results are suppressed here because they already
 * appear in the renderCall header suffix.
 */
export function renderToolResult(
	_toolLabel: string,
	result: ToolResultWithError,
	options: ToolRenderResultOptions,
	theme: ToolTheme,
): ToolRenderComponent {
	const isError = result.isError === true;
	const allLines = extractTextLines(result);

	// Short single-line results appear in the header suffix; skip body
	if (allLines.length <= 1 && (allLines[0]?.trim().length ?? 0) <= MAX_ARG_PREVIEW) {
		return { render: () => [] };
	}

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

/**
 * Label config for createToolRenderers.
 * - string: static label for both pending and done states.
 * - { pending, done }: different labels per state; done may be a function
 *   that receives the call args so it can vary by action.
 */
export type ToolLabelConfig =
	| string
	| {
			pending: string | ((args: ToolParams) => string);
			done: string | ((args: ToolParams, result?: ToolResultWithError) => string);
	  };

/**
 * Create linked renderCall / renderResult pair with shared state.
 *
 * renderResult feeds result data back into renderCall's options so the
 * call header automatically switches from a pending icon to a
 * success/error icon with a result summary — no mergeCallAndResult needed.
 */
export function createToolRenderers(
	label: ToolLabelConfig,
	formatArgs: (args: ToolParams) => string[],
): {
	renderCall: (args: ToolParams, options: ToolRenderResultOptions, theme: ToolTheme) => ToolRenderComponent;
	renderResult: (
		result: ToolResultWithError,
		options: ToolRenderResultOptions,
		theme: ToolTheme,
		args?: ToolParams,
	) => ToolRenderComponent;
} {
	const state: ToolRenderCallOptions = {};
	return {
		renderCall: (args, options, theme) => {
			const renderState: ToolRenderCallOptions = {
				get isPartial() {
					return options.isPartial;
				},
				get spinnerFrame() {
					return options.spinnerFrame;
				},
				get result() {
					return state.result;
				},
			};
			const resolveLabel =
				typeof label === "string"
					? label
					: () => {
							if (!state.result || options.isPartial) {
								return typeof label.pending === "function" ? label.pending(args) : label.pending;
							}
							return typeof label.done === "function" ? label.done(args, state.result) : label.done;
						};
			return renderToolCall(resolveLabel, () => formatArgs(args), theme, renderState);
		},
		renderResult: (result, options, theme) => {
			state.result = result;
			const resultLabel = typeof label === "string" ? label : label.done;
			return renderToolResult(typeof resultLabel === "function" ? "" : resultLabel, result, options, theme);
		},
	};
}
