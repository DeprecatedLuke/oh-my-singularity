import { marked, type Token } from "marked";
import { UI_MARKDOWN_CACHE_LIMIT } from "../../config/constants";
import { BOLD, BOX, FG, RESET_FG, UNBOLD, visibleWidth } from "../colors";

const ITALIC = "\x1b[3m";
const UNITALIC = "\x1b[23m";
const UNDERLINE = "\x1b[4m";
const UNUNDERLINE = "\x1b[24m";
const STRIKETHROUGH = "\x1b[9m";
const UNSTRIKETHROUGH = "\x1b[29m";

const TABLE_TEE_DOWN = "┬";
const TABLE_TEE_UP = "┴";
const TABLE_CROSS = "┼";

const MARKDOWN_CACHE_LIMIT = UI_MARKDOWN_CACHE_LIMIT;
const markdownRenderCache = new Map<string, string[]>();

type MarkdownTableCell = {
	tokens?: Token[];
	text?: string;
};

type MarkdownToken = Token & {
	tokens?: Token[];
	depth?: number;
	lang?: string;
	text?: string;
	href?: string;
	raw?: string;
	ordered?: boolean;
	start?: number;
	items?: MarkdownToken[];
	header?: MarkdownTableCell[];
	rows?: MarkdownTableCell[][];
};

type MarkdownTableToken = MarkdownToken & {
	header?: MarkdownTableCell[];
	rows?: MarkdownTableCell[][];
};

function wrapAnsiLine(line: string, width: number): string[] {
	if (width <= 0) return [];
	if (!line) return [""];
	return Bun.wrapAnsi(line, width, { hard: true }).split("\n");
}

function wrapAnsiText(text: string, width: number): string[] {
	if (width <= 0) return [];
	const segments = text.split("\n");
	const wrapped: string[] = [];
	for (const segment of segments) {
		wrapped.push(...wrapAnsiLine(segment, width));
	}
	return wrapped.length > 0 ? wrapped : [""];
}

class AssistantMarkdownRenderer {
	readonly #width: number;

	constructor(width: number) {
		this.#width = Math.max(1, width);
	}

	render(markdown: string): string[] {
		if (!markdown || !markdown.trim()) return [];

		const normalized = markdown.replace(/\r/g, "");
		const tokens = marked.lexer(normalized);
		const logicalLines: string[] = [];

		for (let i = 0; i < tokens.length; i += 1) {
			const token = tokens[i] as MarkdownToken;
			const nextType = tokens[i + 1]?.type;
			logicalLines.push(...this.#renderToken(token, nextType));
		}

		const wrappedLines: string[] = [];
		for (const line of logicalLines) {
			if (!line) {
				wrappedLines.push("");
				continue;
			}
			wrappedLines.push(...wrapAnsiLine(line, this.#width));
		}

		return wrappedLines;
	}

	#renderToken(token: MarkdownToken, nextTokenType?: string): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const level = typeof token.depth === "number" ? token.depth : 1;
				const headingText = this.#renderInlineTokens(token.tokens ?? []);
				if (level === 1) {
					lines.push(`${FG.accent}${BOLD}${UNDERLINE}${headingText}${UNUNDERLINE}${UNBOLD}${RESET_FG}`);
				} else if (level === 2) {
					lines.push(`${FG.accent}${BOLD}${headingText}${UNBOLD}${RESET_FG}`);
				} else {
					const prefix = `${"#".repeat(level)} `;
					lines.push(`${FG.accent}${BOLD}${prefix}${headingText}${UNBOLD}${RESET_FG}`);
				}
				if (nextTokenType !== "space") lines.push("");
				break;
			}

			case "paragraph": {
				const paragraphText = this.#renderInlineTokens(token.tokens ?? []);
				lines.push(paragraphText);
				if (nextTokenType && nextTokenType !== "space" && nextTokenType !== "list") lines.push("");
				break;
			}

			case "code": {
				lines.push(...this.#renderCodeBlock(token));
				if (nextTokenType !== "space") lines.push("");
				break;
			}

			case "list":
				lines.push(...this.#renderList(token, 0));
				if (nextTokenType && nextTokenType !== "space") lines.push("");
				break;

			case "blockquote": {
				const quoteText = this.#renderInlineTokens(token.tokens ?? []);
				const quoteLines = quoteText ? quoteText.split("\n") : [typeof token.text === "string" ? token.text : ""];
				for (const quoteLine of quoteLines) {
					lines.push(`${FG.border}${BOX.v}${RESET_FG} ${FG.muted}${ITALIC}${quoteLine}${UNITALIC}${RESET_FG}`);
				}
				if (nextTokenType !== "space") lines.push("");
				break;
			}

			case "hr":
				lines.push(`${FG.dim}${BOX.h.repeat(Math.min(this.#width, 80))}${RESET_FG}`);
				if (nextTokenType !== "space") lines.push("");
				break;

			case "table": {
				lines.push(...this.#renderTable(token as MarkdownTableToken));
				if (nextTokenType !== "space") lines.push("");
				break;
			}

			case "html": {
				if (typeof token.raw === "string" && token.raw.trim()) {
					lines.push(token.raw.trim());
					if (nextTokenType !== "space") lines.push("");
				}
				break;
			}

			case "space":
				lines.push("");
				break;

			default: {
				if (typeof token.text === "string" && token.text) {
					lines.push(token.text);
				}
			}
		}

		return lines;
	}

	#renderCodeBlock(token: MarkdownToken): string[] {
		const lines: string[] = [];
		const lang = typeof token.lang === "string" ? token.lang.trim() : "";
		const codeLines = (typeof token.text === "string" ? token.text : "").split("\n");

		const maxContentWidth = Math.max(1, this.#width - 4);
		const wrappedCodeLines: string[] = [];

		for (const codeLine of codeLines) {
			wrappedCodeLines.push(...wrapAnsiText(codeLine, maxContentWidth));
		}

		if (wrappedCodeLines.length === 0) wrappedCodeLines.push("");

		const label = lang ? ` ${lang} ` : "";
		const longestWrappedLine = wrappedCodeLines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
		const minFrameWidth = label ? Math.min(maxContentWidth, label.length) : 1;
		const frameContentWidth = Math.max(minFrameWidth, Math.min(maxContentWidth, longestWrappedLine));

		lines.push(this.#renderCodeTopBorder(label, frameContentWidth));

		const border = `${FG.border}${BOX.v}${RESET_FG}`;
		for (const codeLine of wrappedCodeLines) {
			const paddedCodeLine = `${codeLine}${" ".repeat(Math.max(0, frameContentWidth - visibleWidth(codeLine)))}`;
			lines.push(`${border} ${FG.muted}${paddedCodeLine}${RESET_FG} ${border}`);
		}

		lines.push(`${FG.border}${BOX.bl}${BOX.h.repeat(frameContentWidth + 2)}${BOX.br}${RESET_FG}`);
		return lines;
	}

	#renderCodeTopBorder(label: string, frameContentWidth: number): string {
		if (!label) {
			return `${FG.border}${BOX.tl}${BOX.h.repeat(frameContentWidth + 2)}${BOX.tr}${RESET_FG}`;
		}

		const clampedLabel =
			label.length <= frameContentWidth ? label : `${label.slice(0, Math.max(0, frameContentWidth - 1))}…`;
		const trailingWidth = Math.max(0, frameContentWidth + 1 - clampedLabel.length);

		return `${FG.border}${BOX.tl}${BOX.h}${FG.accent}${BOLD}${clampedLabel}${UNBOLD}${FG.border}${BOX.h.repeat(trailingWidth)}${BOX.tr}${RESET_FG}`;
	}

	#renderTable(token: MarkdownTableToken): string[] {
		const lines: string[] = [];
		const header = Array.isArray(token.header) ? token.header : [];
		const rows = Array.isArray(token.rows) ? token.rows : [];
		const rowWidth = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
		const numCols = Math.max(header.length, rowWidth);

		if (numCols === 0) return lines;

		// Border overhead with format: "│ " + cells.join(" │ ") + " │"
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = this.#width - borderOverhead;
		if (availableForCells < numCols) {
			if (typeof token.raw === "string" && token.raw.trim()) {
				return token.raw.split("\n").flatMap(rawLine => wrapAnsiLine(rawLine, this.#width));
			}
			return lines;
		}

		const maxUnbrokenWordWidth = 30;
		const naturalWidths = new Array<number>(numCols).fill(1);
		const minWordWidths = new Array<number>(numCols).fill(1);

		for (let i = 0; i < numCols; i += 1) {
			const headerText = this.#getCellText(header[i]);
			naturalWidths[i] = Math.max(naturalWidths[i] ?? 1, this.#getLongestLineWidth(headerText));
			minWordWidths[i] = Math.max(
				minWordWidths[i] ?? 1,
				this.#getLongestWordWidth(headerText, maxUnbrokenWordWidth),
			);
		}

		for (const row of rows) {
			for (let i = 0; i < numCols; i += 1) {
				const cellText = this.#getCellText(row?.[i]);
				naturalWidths[i] = Math.max(naturalWidths[i] ?? 1, this.#getLongestLineWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] ?? 1,
					this.#getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = [...minWordWidths];
		let minCellsWidth = minColumnWidths.reduce((total, width) => total + width, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map(width => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i += 1) {
					minColumnWidths[i] = (minColumnWidths[i] ?? 0) + (growth[i] ?? 0);
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i += 1) {
					minColumnWidths[i] = (minColumnWidths[i] ?? 0) + 1;
					leftover -= 1;
				}
			}

			minCellsWidth = minColumnWidths.reduce((total, width) => total + width, 0);
		}

		const totalNaturalWidth = naturalWidths.reduce((total, width) => total + width, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= this.#width) {
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index] ?? 1));
		} else {
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - (minColumnWidths[index] ?? 1));
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);

			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index] ?? minWidth;
				const growPotential = Math.max(0, naturalWidth - minWidth);
				const grow = totalGrowPotential > 0 ? Math.floor((growPotential / totalGrowPotential) * extraWidth) : 0;
				return minWidth + grow;
			});

			const allocated = columnWidths.reduce((total, width) => total + width, 0);
			let remaining = availableForCells - allocated;

			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i += 1) {
					if ((columnWidths[i] ?? 1) < (naturalWidths[i] ?? 1)) {
						columnWidths[i] = (columnWidths[i] ?? 0) + 1;
						remaining -= 1;
						grew = true;
					}
				}
				if (!grew) break;
			}
		}

		lines.push(this.#buildTableBorder(BOX.tl, TABLE_TEE_DOWN, BOX.tr, columnWidths));

		const headerCellLines = Array.from({ length: numCols }, (_, index) =>
			this.#wrapCellText(this.#getCellText(header[index]), columnWidths[index] ?? 1),
		);
		const headerLineCount = Math.max(1, ...headerCellLines.map(cellLines => cellLines.length));
		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx += 1) {
			lines.push(this.#renderTableRow(headerCellLines, lineIdx, columnWidths, text => `${BOLD}${text}${UNBOLD}`));
		}

		const separatorLine = this.#buildTableBorder(BOX.tR, TABLE_CROSS, BOX.tL, columnWidths);
		lines.push(separatorLine);

		for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
			const row = rows[rowIndex] ?? [];
			const rowCellLines = Array.from({ length: numCols }, (_, index) =>
				this.#wrapCellText(this.#getCellText(row[index]), columnWidths[index] ?? 1),
			);
			const rowLineCount = Math.max(1, ...rowCellLines.map(cellLines => cellLines.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx += 1) {
				lines.push(this.#renderTableRow(rowCellLines, lineIdx, columnWidths));
			}

			if (rowIndex < rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		lines.push(this.#buildTableBorder(BOX.bl, TABLE_TEE_UP, BOX.br, columnWidths));

		return lines;
	}

	#buildTableBorder(left: string, join: string, right: string, widths: readonly number[]): string {
		const cells = widths.map(width => BOX.h.repeat(Math.max(1, width)));
		return `${FG.border}${left}${BOX.h}${cells.join(`${BOX.h}${join}${BOX.h}`)}${BOX.h}${right}${RESET_FG}`;
	}

	#renderTableRow(
		cellLinesByColumn: readonly string[][],
		lineIdx: number,
		columnWidths: readonly number[],
		styleCell?: (text: string) => string,
	): string {
		const border = `${FG.border}${BOX.v}${RESET_FG}`;
		const cells: string[] = [];

		for (let i = 0; i < columnWidths.length; i += 1) {
			const width = columnWidths[i] ?? 1;
			const line = cellLinesByColumn[i]?.[lineIdx] ?? "";
			const padded = `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
			cells.push(styleCell ? styleCell(padded) : padded);
		}

		return `${border} ${cells.join(` ${border} `)} ${border}`;
	}

	#getCellText(cell?: MarkdownTableCell): string {
		if (!cell) return "";
		if (Array.isArray(cell.tokens) && cell.tokens.length > 0) {
			return this.#renderInlineTokens(cell.tokens);
		}
		return typeof cell.text === "string" ? cell.text : "";
	}

	#getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter(word => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) return longest;
		return Math.min(longest, maxWidth);
	}

	#getLongestLineWidth(text: string): number {
		const lines = text.split("\n");
		let longest = 0;
		for (const line of lines) {
			longest = Math.max(longest, visibleWidth(line));
		}
		return longest;
	}

	#wrapCellText(text: string, maxWidth: number): string[] {
		return wrapAnsiText(text, Math.max(1, maxWidth));
	}

	#renderList(token: MarkdownToken, depth: number): string[] {
		const lines: string[] = [];
		const items = Array.isArray(token.items) ? token.items : [];
		const ordered = token.ordered === true;
		const start = typeof token.start === "number" ? token.start : 1;
		const indent = "  ".repeat(depth);
		const nestedIndent = "  ".repeat(depth + 1);

		for (let i = 0; i < items.length; i += 1) {
			const item = items[i]!;
			const bullet = ordered ? `${start + i}. ` : "• ";
			const marker = `${FG.accent}${bullet}${RESET_FG}`;
			const itemLines = this.#renderListItem(item.tokens ?? [], depth);

			if (itemLines.length === 0) {
				lines.push(`${indent}${marker}`);
				continue;
			}

			const firstLine = itemLines[0] ?? "";
			if (firstLine.startsWith(nestedIndent)) {
				lines.push(firstLine);
			} else {
				lines.push(`${indent}${marker}${firstLine}`);
			}

			for (let j = 1; j < itemLines.length; j += 1) {
				const line = itemLines[j] ?? "";
				if (line.startsWith(nestedIndent)) {
					lines.push(line);
				} else {
					lines.push(`${indent}  ${line}`);
				}
			}
		}

		return lines;
	}

	#renderListItem(tokens: readonly Token[], parentDepth: number): string[] {
		const lines: string[] = [];

		for (const rawToken of tokens) {
			const token = rawToken as MarkdownToken;
			if (token.type === "list") {
				lines.push(...this.#renderList(token, parentDepth + 1));
				continue;
			}

			if (token.type === "paragraph") {
				lines.push(this.#renderInlineTokens(token.tokens ?? []));
				continue;
			}

			if (token.type === "text") {
				if (Array.isArray(token.tokens) && token.tokens.length > 0) {
					lines.push(this.#renderInlineTokens(token.tokens));
				} else if (typeof token.text === "string") {
					lines.push(token.text);
				}
				continue;
			}

			if (token.type === "code") {
				lines.push(...this.#renderCodeBlock(token));
				continue;
			}

			const inline = this.#renderInlineTokens([token]);
			if (inline) lines.push(inline);
		}

		return lines;
	}

	#renderInlineTokens(tokens: readonly Token[]): string {
		let result = "";

		for (const rawToken of tokens) {
			const token = rawToken as MarkdownToken;

			switch (token.type) {
				case "text":
					if (Array.isArray(token.tokens) && token.tokens.length > 0) {
						result += this.#renderInlineTokens(token.tokens);
					} else {
						result += token.text ?? "";
					}
					break;

				case "paragraph":
					result += this.#renderInlineTokens(token.tokens ?? []);
					break;

				case "strong":
					result += `${BOLD}${this.#renderInlineTokens(token.tokens ?? [])}${UNBOLD}`;
					break;

				case "em":
					result += `${ITALIC}${this.#renderInlineTokens(token.tokens ?? [])}${UNITALIC}`;
					break;

				case "codespan": {
					const code = token.text ?? "";
					result += `${FG.accent}\`${code}\`${RESET_FG}`;
					break;
				}

				case "link": {
					const linkText = this.#renderInlineTokens(token.tokens ?? []);
					const href = token.href ?? "";
					const hrefForComparison = href.startsWith("mailto:") ? href.slice(7) : href;
					const display = linkText || href;
					const styledText = `${FG.accent}${UNDERLINE}${display}${UNUNDERLINE}${RESET_FG}`;
					if (token.text === href || token.text === hrefForComparison) {
						result += styledText;
					} else {
						result += `${styledText}${FG.dim} (${href})${RESET_FG}`;
					}
					break;
				}

				case "del":
					result += `${STRIKETHROUGH}${this.#renderInlineTokens(token.tokens ?? [])}${UNSTRIKETHROUGH}`;
					break;

				case "br":
					result += "\n";
					break;

				case "html":
					if (typeof token.raw === "string") result += token.raw;
					break;

				default:
					if (typeof token.text === "string") result += token.text;
			}
		}

		return result;
	}
}

function getMarkdownCacheKey(markdown: string, width: number): string {
	return `${width}\u0000${markdown}`;
}

function cacheRenderedMarkdown(key: string, lines: string[]): void {
	markdownRenderCache.set(key, lines);

	if (markdownRenderCache.size <= MARKDOWN_CACHE_LIMIT) return;

	const oldestKey = markdownRenderCache.keys().next().value;
	if (typeof oldestKey === "string") {
		markdownRenderCache.delete(oldestKey);
	}
}

export function renderMarkdownLines(markdown: string, width: number): string[] {
	if (width <= 0 || !markdown) return [];

	const cacheKey = getMarkdownCacheKey(markdown, width);
	const cached = markdownRenderCache.get(cacheKey);
	if (cached) {
		markdownRenderCache.delete(cacheKey);
		markdownRenderCache.set(cacheKey, cached);
		return cached;
	}

	const rendered = new AssistantMarkdownRenderer(width).render(markdown);
	cacheRenderedMarkdown(cacheKey, rendered);
	return rendered;
}
