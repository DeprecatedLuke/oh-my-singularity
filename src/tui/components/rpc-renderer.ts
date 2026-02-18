import { asRecord } from "../../utils";
import { BOX, FG, ICON, lifecycleFg, RESET } from "../colors";
import {
	deriveTaggedText,
	extractAgentRole,
	extractLifecycle,
	formatAgentLogSummary,
	formatDataBackedLogSummary,
	getMaxTaggedTextWidth,
	renderTaggedTextLines,
} from "./lifecycle-formatter";
import { renderMarkdownLines } from "./markdown";
import { sanitizeChunk, wrapLine } from "./text-formatter";
import {
	extractResultText,
	formatToolArgs,
	formatToolResultPreview,
	renderToolBlockLines,
	type ToolBlock,
} from "./tool-renderer";
export type RenderRpcOptions = {
	width: number;
	height: number;
	/** 0-based index into the rendered lines array. Defaults to showing the tail. */
	scrollTop?: number;
	/** Align source/level log tags to a fixed width. */
	alignLogTags?: boolean;
};

// ---- Internal types ----

type TextStyle = "assistant" | "user" | "thinking" | "dim" | "error" | "warn" | "status" | "agentLog";

type TextBlock = {
	kind: "text";
	text: string;
	style: TextStyle;
	/** Optional ANSI fg override — replaces the style's default color when set. */
	color?: string;
	/** Agent role for agentLog style. */
	role?: string;
	/** Lifecycle keyword for agentLog style. */
	lifecycle?: string;
	/** Original log level when event.type === "log". */
	level?: string;
};

type SepBlock = {
	kind: "separator";
	label: string;
};

type RenderBlock = TextBlock | ToolBlock | SepBlock;

type ToolExecState = {
	blockIndex: number;
	toolName: string;
	args?: unknown;
	rawArgsBuffer?: string;
	argsComplete: boolean;
};
type StreamState = {
	assistantBlockIndex: number | null;
	thinkingBlockIndex: number | null;
	userInputBlockIndex: number | null;
	toolExecByCallId: Map<string, ToolExecState>;
	activeToolCallId: string | null;
	activeToolBlockIndex: number | null;
	activeToolRawArgsBuffer?: string;
};
// ---- Block management ----

function pushBlock(blocks: RenderBlock[], block: RenderBlock): number {
	blocks.push(block);
	return blocks.length - 1;
}

function ensureTextBlock(blocks: RenderBlock[], currentIndex: number | null, style: TextStyle): number {
	if (currentIndex !== null && blocks[currentIndex]?.kind === "text") return currentIndex;
	return pushBlock(blocks, { kind: "text", text: "", style });
}

function appendToTextBlock(
	blocks: RenderBlock[],
	currentIndex: number | null,
	chunk: string,
	style: TextStyle,
): number {
	const clean = sanitizeChunk(chunk);
	if (!clean) return ensureTextBlock(blocks, currentIndex, style);

	if (currentIndex !== null) {
		const existing = blocks[currentIndex];
		if (existing?.kind === "text") {
			existing.text += clean;
			return currentIndex;
		}
	}

	return pushBlock(blocks, { kind: "text", text: clean, style });
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return sanitizeChunk(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		const rec = asRecord(item);
		if (!rec) continue;
		const itemType = typeof rec.type === "string" ? rec.type : "";
		if ((itemType === "text" || itemType === "input_text") && typeof rec.text === "string") {
			const clean = sanitizeChunk(rec.text);
			if (clean) parts.push(clean);
		}
	}
	return parts.join("\n");
}

function formatUserPromptText(content: string): string {
	return `Input: ${content}`;
}

function formatInitialPromptText(content: string): string {
	return `Task Prompt: ${content}`;
}

function parseToolCallArgs(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function normalizeToolCallArgs(value: unknown): { args?: unknown; rawArgsBuffer?: string } | null {
	if (value === undefined) return null;
	if (typeof value === "string") {
		const parsed = parseToolCallArgs(value);
		if (parsed === undefined) return { rawArgsBuffer: value };
		return { args: parsed, rawArgsBuffer: value };
	}
	return { args: value };
}

function extractToolCallArgsFromEvent(
	event: Record<string, unknown>,
	previousRawArgsBuffer?: string,
): { args?: unknown; rawArgsBuffer?: string } | null {
	const toolCall = asRecord(event.toolCall);
	if (toolCall && "arguments" in toolCall) return normalizeToolCallArgs(toolCall.arguments);
	if ("arguments" in event) return normalizeToolCallArgs(event.arguments);
	const deltaRecord = asRecord(event.delta);
	if (deltaRecord) {
		if ("arguments" in deltaRecord) return normalizeToolCallArgs(deltaRecord.arguments);
		return { args: deltaRecord };
	}
	if (typeof event.delta === "string") {
		const rawArgsBuffer = `${previousRawArgsBuffer ?? ""}${event.delta}`;
		const parsed = parseToolCallArgs(rawArgsBuffer);
		return parsed === undefined ? { rawArgsBuffer } : { args: parsed, rawArgsBuffer };
	}
	return null;
}

function resolveToolCallId(
	event: Record<string, unknown>,
	toolCall: Record<string, unknown> | null,
	state: StreamState,
): string | null {
	if (toolCall && typeof toolCall.id === "string" && toolCall.id.trim()) return toolCall.id;
	if (typeof event.toolCallId === "string" && event.toolCallId.trim()) return event.toolCallId;
	return state.activeToolCallId;
}

function mergeToolArgs(previousArgs: unknown, nextArgs: unknown): unknown {
	const nextRecord = asRecord(nextArgs);
	if (!nextRecord) return nextArgs;
	const previousRecord = asRecord(previousArgs);
	if (!previousRecord) return nextRecord;
	return { ...previousRecord, ...nextRecord };
}

function createPendingToolBlock(toolName: string, args: unknown, argsComplete: boolean): ToolBlock {
	return {
		kind: "tool",
		toolName,
		argsPreview: args === undefined ? "" : formatToolArgs(toolName, args),
		argsData: args,
		resultPreview: "",
		resultContent: "",
		resultData: undefined,
		state: "pending",
		argsComplete,
	};
}

// ---- Message event handlers ----
function handleAssistantMessageEvent(event: Record<string, unknown>, state: StreamState, blocks: RenderBlock[]): void {
	const type = typeof event.type === "string" ? event.type : "";

	if (type === "text_start") {
		state.assistantBlockIndex = ensureTextBlock(blocks, state.assistantBlockIndex, "assistant");
		return;
	}

	if (type === "text_delta") {
		state.assistantBlockIndex = appendToTextBlock(
			blocks,
			state.assistantBlockIndex,
			typeof event.delta === "string" ? event.delta : "",
			"assistant",
		);
		return;
	}

	if (type === "text_end") {
		if (state.assistantBlockIndex === null || !blocks[state.assistantBlockIndex]) {
			state.assistantBlockIndex = appendToTextBlock(
				blocks,
				state.assistantBlockIndex,
				typeof event.content === "string" ? event.content : "",
				"assistant",
			);
		}
		state.assistantBlockIndex = null;
		return;
	}

	if (type === "thinking_start") {
		state.thinkingBlockIndex = ensureTextBlock(blocks, state.thinkingBlockIndex, "thinking");
		return;
	}

	if (type === "thinking_delta") {
		state.thinkingBlockIndex = appendToTextBlock(
			blocks,
			state.thinkingBlockIndex,
			typeof event.delta === "string" ? event.delta : "",
			"thinking",
		);
		return;
	}

	if (type === "thinking_end") {
		state.thinkingBlockIndex = null;
		return;
	}

	// toolcall_*: create/update pending ToolBlock while args stream in.
	if (type === "toolcall_start") {
		const toolCall = asRecord(event.toolCall);
		const id = resolveToolCallId(event, toolCall, state);
		const name = toolCall && typeof toolCall.name === "string" ? toolCall.name : "?";
		const initialArgs = extractToolCallArgsFromEvent(event);
		const block = createPendingToolBlock(name, initialArgs?.args, false);
		const idx = pushBlock(blocks, block);
		state.activeToolCallId = id;
		state.activeToolBlockIndex = idx;
		state.activeToolRawArgsBuffer = initialArgs?.rawArgsBuffer;
		if (id) {
			state.toolExecByCallId.set(id, {
				blockIndex: idx,
				toolName: name,
				args: initialArgs?.args,
				rawArgsBuffer: initialArgs?.rawArgsBuffer,
				argsComplete: false,
			});
		}
		return;
	}

	if (type === "toolcall_delta") {
		const toolCall = asRecord(event.toolCall);
		const id = resolveToolCallId(event, toolCall, state);
		const prev = id ? state.toolExecByCallId.get(id) : null;
		const blockIndex = prev?.blockIndex ?? state.activeToolBlockIndex;
		if (blockIndex === null) return;
		const block = blocks[blockIndex];
		if (block?.kind !== "tool") return;
		const nextName =
			toolCall && typeof toolCall.name === "string" ? toolCall.name : (prev?.toolName ?? block.toolName);
		const argUpdate = extractToolCallArgsFromEvent(event, prev?.rawArgsBuffer ?? state.activeToolRawArgsBuffer);
		if (!argUpdate) return;
		const previousArgs = prev?.args ?? block.argsData;
		const mergedArgs = argUpdate.args !== undefined ? mergeToolArgs(previousArgs, argUpdate.args) : previousArgs;
		block.toolName = nextName;
		if (mergedArgs !== undefined) {
			block.argsData = mergedArgs;
			block.argsPreview = formatToolArgs(nextName, mergedArgs);
		}
		block.argsComplete = false;
		if (prev) {
			prev.toolName = nextName;
			prev.args = mergedArgs;
			if (argUpdate.rawArgsBuffer !== undefined) prev.rawArgsBuffer = argUpdate.rawArgsBuffer;
			prev.argsComplete = false;
		} else if (id) {
			state.toolExecByCallId.set(id, {
				blockIndex,
				toolName: nextName,
				args: mergedArgs,
				rawArgsBuffer: argUpdate.rawArgsBuffer ?? state.activeToolRawArgsBuffer,
				argsComplete: false,
			});
			state.activeToolCallId = id;
			state.activeToolRawArgsBuffer = argUpdate.rawArgsBuffer ?? state.activeToolRawArgsBuffer;
		} else {
			state.activeToolRawArgsBuffer = argUpdate.rawArgsBuffer ?? state.activeToolRawArgsBuffer;
		}
		return;
	}
	if (type === "toolcall_end") {
		const toolCall = asRecord(event.toolCall);
		const id = resolveToolCallId(event, toolCall, state);
		const prev = id ? state.toolExecByCallId.get(id) : null;
		const blockIndex = prev?.blockIndex ?? state.activeToolBlockIndex;
		const name = toolCall && typeof toolCall.name === "string" ? toolCall.name : (prev?.toolName ?? "?");
		const finalArgsUpdate = extractToolCallArgsFromEvent(event, prev?.rawArgsBuffer ?? state.activeToolRawArgsBuffer);
		if (blockIndex !== null) {
			const block = blocks[blockIndex];
			if (block?.kind === "tool") {
				const previousArgs = prev?.args ?? block.argsData;
				const finalArgs =
					finalArgsUpdate?.args !== undefined ? mergeToolArgs(previousArgs, finalArgsUpdate.args) : previousArgs;
				block.toolName = name;
				if (finalArgs !== undefined) {
					block.argsData = finalArgs;
					block.argsPreview = formatToolArgs(name, finalArgs);
				}
				block.argsComplete = true;
				if (id) {
					state.toolExecByCallId.set(id, {
						blockIndex,
						toolName: name,
						args: finalArgs,
						rawArgsBuffer: finalArgsUpdate?.rawArgsBuffer ?? prev?.rawArgsBuffer,
						argsComplete: true,
					});
				}
				state.activeToolCallId = null;
				state.activeToolBlockIndex = null;
				state.activeToolRawArgsBuffer = undefined;
				return;
			}
		}
		const block = createPendingToolBlock(name, finalArgsUpdate?.args, true);
		const idx = pushBlock(blocks, block);
		if (id) {
			state.toolExecByCallId.set(id, {
				blockIndex: idx,
				toolName: name,
				args: finalArgsUpdate?.args,
				rawArgsBuffer: finalArgsUpdate?.rawArgsBuffer,
				argsComplete: true,
			});
		}
		state.activeToolCallId = null;
		state.activeToolBlockIndex = null;
		state.activeToolRawArgsBuffer = undefined;
		return;
	}
	if (type === "done") {
		state.assistantBlockIndex = null;
		state.thinkingBlockIndex = null;
		return;
	}

	if (type === "error") {
		const reason = typeof event.reason === "string" ? event.reason : "?";
		pushBlock(blocks, { kind: "text", text: `error: ${reason}`, style: "error" });
		state.assistantBlockIndex = null;
		state.thinkingBlockIndex = null;
		return;
	}
}

function handleToolExecutionEvent(event: Record<string, unknown>, state: StreamState, blocks: RenderBlock[]): void {
	const type = typeof event.type === "string" ? event.type : "";
	const toolName = typeof event.toolName === "string" ? event.toolName : "?";
	const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : null;
	if (type === "tool_execution_start") {
		const eventArgs = event.args;
		const args = formatToolArgs(toolName, eventArgs);
		// Update existing block from toolcall_* if available
		if (toolCallId) {
			const prev = state.toolExecByCallId.get(toolCallId);
			if (prev) {
				const block = blocks[prev.blockIndex];
				if (block?.kind === "tool") {
					if (eventArgs !== undefined) prev.args = eventArgs;
					prev.argsComplete = true;
					if (args) block.argsPreview = args;
					if (eventArgs !== undefined) block.argsData = eventArgs;
					block.argsComplete = true;
					if (state.activeToolCallId === toolCallId) {
						state.activeToolCallId = null;
						state.activeToolBlockIndex = null;
						state.activeToolRawArgsBuffer = undefined;
					}
					return;
				}
			}
		}
		// No existing block — create new one
		const block = createPendingToolBlock(toolName, eventArgs, true);
		const idx = pushBlock(blocks, block);
		if (toolCallId) {
			state.toolExecByCallId.set(toolCallId, { blockIndex: idx, toolName, args: eventArgs, argsComplete: true });
			if (state.activeToolCallId === toolCallId) {
				state.activeToolCallId = null;
				state.activeToolBlockIndex = null;
				state.activeToolRawArgsBuffer = undefined;
			}
		}
		return;
	}
	if (type === "tool_execution_update") {
		const prev = toolCallId ? state.toolExecByCallId.get(toolCallId) : null;
		const resultArgs = event.args !== undefined ? event.args : prev?.args;
		const partialText = extractResultText(event.partialResult);
		const partial = partialText || formatToolResultPreview(event.partialResult, 100, { toolName, args: resultArgs });
		if (prev) {
			const block = blocks[prev.blockIndex];
			if (block?.kind === "tool") {
				if (event.args !== undefined) prev.args = event.args;
				prev.argsComplete = true;
				block.argsData = resultArgs;
				block.argsComplete = true;
				block.resultContent = partialText;
				block.resultPreview = partialText ? "" : partial || "…";
				block.resultData = event.partialResult;
				return;
			}
		}
		const block = createPendingToolBlock(toolName, resultArgs, true);
		block.resultPreview = partialText ? "" : partial || "…";
		block.resultContent = partialText;
		block.resultData = event.partialResult;
		const idx = pushBlock(blocks, block);
		if (toolCallId) {
			state.toolExecByCallId.set(toolCallId, { blockIndex: idx, toolName, args: resultArgs, argsComplete: true });
		}
		return;
	}
	if (type === "tool_execution_end") {
		const isError = event.isError === true;
		const prev = toolCallId ? state.toolExecByCallId.get(toolCallId) : null;
		const resultArgs = event.args !== undefined ? event.args : prev?.args;
		const resultText = extractResultText(event.result);
		const result = resultText || formatToolResultPreview(event.result, 200, { toolName, args: resultArgs, isError });
		if (prev) {
			const block = blocks[prev.blockIndex];
			if (block?.kind === "tool") {
				if (resultArgs !== undefined) prev.args = resultArgs;
				prev.argsComplete = true;
				block.argsData = resultArgs;
				block.argsComplete = true;
				block.resultContent = resultText;
				block.resultPreview = resultText ? "" : result;
				block.resultData = event.result;
				block.state = isError ? "error" : "success";
				if (toolCallId) state.toolExecByCallId.delete(toolCallId);
				if (state.activeToolCallId === toolCallId) {
					state.activeToolCallId = null;
					state.activeToolBlockIndex = null;
					state.activeToolRawArgsBuffer = undefined;
				}
				return;
			}
		}
		pushBlock(blocks, {
			kind: "tool",
			toolName,
			argsPreview: resultArgs === undefined ? "" : formatToolArgs(toolName, resultArgs),
			argsData: resultArgs,
			resultPreview: resultText ? "" : result,
			resultContent: resultText,
			resultData: event.result,
			state: isError ? "error" : "success",
			argsComplete: true,
		});
		if (toolCallId) state.toolExecByCallId.delete(toolCallId);
		if (state.activeToolCallId === toolCallId) {
			state.activeToolCallId = null;
			state.activeToolBlockIndex = null;
			state.activeToolRawArgsBuffer = undefined;
		}
	}
}

function handleRpcEvent(event: Record<string, unknown>, state: StreamState, blocks: RenderBlock[]): boolean {
	const type = typeof event.type === "string" ? event.type : null;
	if (!type) return false;

	// Suppress structural noise
	if (type === "agent_start" || type === "agent_end") return true;
	if (type === "initial_prompt") {
		const content = typeof event.text === "string" ? sanitizeChunk(event.text) : "";
		if (!content.trim()) return true;
		state.thinkingBlockIndex = null;
		state.assistantBlockIndex = null;
		state.userInputBlockIndex = null;
		pushBlock(blocks, {
			kind: "text",
			text: formatInitialPromptText(content),
			style: "status",
			color: FG.accent,
		});
		return true;
	}
	if (type === "message_start" || type === "message_end") {
		const message = asRecord(event.message);
		if (!message) return true;
		const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
		if (role !== "" && role !== "user") return true;
		const content = extractMessageText(message.content);
		const hasContent = content.trim().length > 0;
		if (type === "message_start") {
			// Terminate any active thinking/assistant block so interrupt visually splits
			state.thinkingBlockIndex = null;
			state.assistantBlockIndex = null;
			state.userInputBlockIndex = pushBlock(blocks, {
				kind: "text",
				text: hasContent ? formatUserPromptText(content) : "",
				style: "user",
			});
			return true;
		}
		if (state.userInputBlockIndex !== null) {
			const block = blocks[state.userInputBlockIndex];
			if (block?.kind === "text" && block.style === "user" && hasContent) {
				block.text = formatUserPromptText(content);
			}
			state.userInputBlockIndex = null;
			return true;
		}
		if (hasContent) {
			state.thinkingBlockIndex = null;
			state.assistantBlockIndex = null;
			pushBlock(blocks, { kind: "text", text: formatUserPromptText(content), style: "user" });
		}
		return true;
	}
	if (type === "turn_end") {
		state.userInputBlockIndex = null;
		return true;
	}

	if (type === "turn_start") {
		// Deduplicate consecutive turn separators (e.g. interrupt causes back-to-back turn_start)
		const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
		if (lastBlock?.kind === "separator") return true;
		const idx = typeof event.turnIndex === "number" ? event.turnIndex : null;
		pushBlock(blocks, { kind: "separator", label: idx !== null ? `Turn ${idx + 1}` : "Turn" });
		return true;
	}

	if (type === "message_update") {
		const inner = asRecord(event.assistantMessageEvent);
		if (inner) handleAssistantMessageEvent(inner, state, blocks);
		return true;
	}

	if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
		handleToolExecutionEvent(event, state, blocks);
		return true;
	}

	if (type === "rpc_exit") {
		const code = typeof event.exitCode === "number" ? String(event.exitCode) : "?";
		pushBlock(blocks, { kind: "text", text: `process exited (${code})`, style: "warn" });
		return true;
	}

	if (type === "rpc_parse_error") {
		const err = typeof event.error === "string" ? event.error : "parse error";
		pushBlock(blocks, { kind: "text", text: `parse error: ${err}`, style: "error" });
		return true;
	}

	return false;
}
// ---- Build blocks from events ----

function buildRenderBlocks(events: readonly unknown[]): RenderBlock[] {
	const blocks: RenderBlock[] = [];
	const state: StreamState = {
		assistantBlockIndex: null,
		thinkingBlockIndex: null,
		userInputBlockIndex: null,
		toolExecByCallId: new Map(),
		activeToolCallId: null,
		activeToolBlockIndex: null,
		activeToolRawArgsBuffer: undefined,
	};

	for (const event of events) {
		const rec = asRecord(event);
		if (!rec) continue;

		const t = typeof rec.type === "string" ? rec.type : null;

		if (t === "log") {
			const level = typeof rec.level === "string" ? rec.level : "log";
			const message = typeof rec.message === "string" ? rec.message : "";
			const data = asRecord(rec.data);
			const role = extractAgentRole(data);
			const text = message || level;
			if (role) {
				const lifecycle = extractLifecycle(data, text, level);
				const summary = formatAgentLogSummary(role, lifecycle, level, text, data);
				pushBlock(blocks, { kind: "text", text: summary, style: "agentLog", role, lifecycle, level });
			} else {
				const style: TextStyle = level === "error" ? "error" : level === "warn" ? "warn" : "dim";
				const summary = formatDataBackedLogSummary(text, level, data);
				pushBlock(blocks, { kind: "text", text: summary, style, level });
			}
			continue;
		}

		if (t === "status") {
			const status = typeof rec.status === "string" ? rec.status : "";
			const note = typeof rec.note === "string" ? rec.note : "";
			pushBlock(blocks, {
				kind: "text",
				text: note ? `${status}: ${note}` : status,
				style: "status",
				color: lifecycleFg(status),
			});
			continue;
		}

		if (t === "rpc") {
			const inner = asRecord(rec.data);
			if (inner && handleRpcEvent(inner, state, blocks)) continue;
			continue;
		}

		if (handleRpcEvent(rec, state, blocks)) continue;
	}

	return blocks;
}

// ---- Render blocks → styled terminal lines ----
function renderTextBlockLines(block: TextBlock, width: number, tagContentWidth = 0): string[] {
	if (width <= 0 || !block.text) return [];
	const tagged = deriveTaggedText(block);
	if (tagged) {
		if (block.style === "agentLog") {
			const widthForTag = tagContentWidth > 0 ? tagContentWidth : tagged.tag.length;
			const gap = tagContentWidth > 0 ? undefined : 1;
			return renderTaggedTextLines(tagged, width, widthForTag, gap);
		}
		if (tagContentWidth > 0) return renderTaggedTextLines(tagged, width, tagContentWidth);
	}
	const wrapped = wrapLine(block.text, width);
	if (wrapped.length === 0) return [];
	switch (block.style) {
		case "assistant": {
			const markdownLines = renderMarkdownLines(block.text, width);
			return markdownLines.length > 0 ? markdownLines : wrapped;
		}
		case "user":
			return wrapped.map(line => `${FG.border}${line}${RESET}`);
		case "thinking":
			// Dim gray text
			return wrapped.map(line => `${FG.dim}${line}${RESET}`);
		case "dim":
			return wrapped.map(line => `${FG.dim}${line}${RESET}`);
		case "error":
			return wrapped.map((line, i) => {
				const prefix = i === 0 ? `${ICON.error} ` : "  ";
				return `${FG.error}${prefix}${line}${RESET}`;
			});
		case "warn":
			return wrapped.map((line, i) => {
				const prefix = i === 0 ? `${ICON.warning} ` : "  ";
				return `${FG.warning}${prefix}${line}${RESET}`;
			});
		case "status":
			return wrapped.map(line => `${block.color ?? FG.muted}${line}${RESET}`);
		case "agentLog": {
			const msgColor = block.lifecycle ? lifecycleFg(block.lifecycle) : FG.dim;
			return wrapped.map(line => `${msgColor}${line}${RESET}`);
		}
		default:
			return wrapped;
	}
}

function renderSepBlockLines(block: SepBlock, width: number): string[] {
	if (width <= 0) return [];

	const label = block.label ? ` ${block.label} ` : "";
	const totalFill = Math.max(0, width - label.length);
	const leftFill = Math.floor(totalFill / 2);
	const rightFill = totalFill - leftFill;
	return [`${FG.dim}${BOX.h.repeat(leftFill)}${label}${BOX.h.repeat(rightFill)}${RESET}`];
}

function renderBlocksToLines(
	blocks: readonly RenderBlock[],
	width: number,
	opts?: { alignLogTags?: boolean },
): string[] {
	const lines: string[] = [];
	const tagContentWidth = opts?.alignLogTags ? getMaxTaggedTextWidth(blocks) : 0;
	for (let i = 0; i < blocks.length; i += 1) {
		const block = blocks[i]!;

		switch (block.kind) {
			case "text":
				lines.push(...renderTextBlockLines(block, width, tagContentWidth));
				break;
			case "tool":
				lines.push(...renderToolBlockLines(block, width));
				break;
			case "separator":
				lines.push(...renderSepBlockLines(block, width));
				break;
		}
	}
	return lines;
}

// ---- Public API ----

export function getRenderedRpcLines(
	events: readonly unknown[],
	widthInput: number,
	opts?: { alignLogTags?: boolean },
): string[] {
	const width = Math.max(0, widthInput);
	if (width <= 0) return [];
	const blocks = buildRenderBlocks(events);
	return renderBlocksToLines(blocks, width, opts);
}

export function renderRpcEvents(events: readonly unknown[], opts: RenderRpcOptions): string[] {
	const width = Math.max(0, opts.width);
	const height = Math.max(0, opts.height);

	if (width <= 0 || height <= 0) return [];

	const lines = getRenderedRpcLines(events, width, { alignLogTags: opts.alignLogTags });

	const maxScrollTop = Math.max(0, lines.length - height);
	const defaultScrollTop = maxScrollTop;
	const rawScrollTop =
		typeof opts.scrollTop === "number" && Number.isFinite(opts.scrollTop)
			? Math.trunc(opts.scrollTop)
			: defaultScrollTop;
	const scrollTop = Math.max(0, Math.min(maxScrollTop, rawScrollTop));

	return lines.slice(scrollTop, scrollTop + height);
}
