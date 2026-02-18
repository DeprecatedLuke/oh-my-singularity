import type { AgentRegistry } from "../../agents/registry";
import type { SessionLogWriter } from "../../session-log-writer";
import { clipAnsi, visibleWidth } from "../colors";
import { getRenderedRpcLines } from "../components/rpc-renderer";

type TerminalLike = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

type Region = { x: number; y: number; width: number; height: number };

function coerceOmsVisibility(state: unknown): boolean {
	if (!state || typeof state !== "object" || Array.isArray(state)) return false;
	const rec = state as { omsMessagesVisible?: unknown };
	return rec.omsMessagesVisible === true;
}

function clipPadAnsi(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = clipAnsi(text, width);
	const vw = visibleWidth(clipped);
	if (vw >= width) return `${clipped}\x1b[0m`;
	return `${clipped}\x1b[0m${" ".repeat(width - vw)}`;
}

export class SystemPane {
	readonly #registry: AgentRegistry;
	readonly #agentId: string;
	readonly #onDirty?: () => void;
	readonly #sessionLogWriter?: SessionLogWriter;

	#scrollTop = 0;
	#followTail = true;

	constructor(opts: {
		registry: AgentRegistry;
		agentId: string;
		onDirty?: () => void;
		sessionLogWriter?: SessionLogWriter;
	}) {
		this.#registry = opts.registry;
		this.#agentId = opts.agentId;
		this.#onDirty = opts.onDirty;
		this.#sessionLogWriter = opts.sessionLogWriter;

		const writer = this.#sessionLogWriter;
		if (!writer) return;

		const existingEvents = this.#registry.get(this.#agentId)?.events ?? [];
		for (const event of existingEvents) {
			writer.appendOmsEvent(this.#agentId, event);
		}

		this.#registry.onEvent((agentId, event) => {
			if (agentId !== this.#agentId) return;
			writer.appendOmsEvent(agentId, event);
		});
	}

	handleMouse(name: string, _data: any, region: Region): boolean {
		const dir = name === "MOUSE_WHEEL_UP" ? -1 : name === "MOUSE_WHEEL_DOWN" ? 1 : 0;
		if (!dir) return false;

		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);
		if (width <= 0 || height <= 0) return false;

		const agent = this.#registry.get(this.#agentId);
		const events = agent?.events ?? [];
		const allLines = getRenderedRpcLines(events, width, { alignLogTags: true });
		const maxScrollTop = Math.max(0, allLines.length - height);
		const current = this.#followTail ? maxScrollTop : Math.min(maxScrollTop, this.#scrollTop);

		const step = 3;
		const next = Math.max(0, Math.min(maxScrollTop, current + dir * step));
		this.#scrollTop = next;
		this.#followTail = next === maxScrollTop;
		this.#onDirty?.();
		return true;
	}

	render(term: TerminalLike, region: Region, state?: unknown): void {
		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);
		if (width <= 0 || height <= 0) return;
		if (!coerceOmsVisibility(state)) {
			for (let row = 0; row < height; row += 1) {
				term.moveTo(region.x, region.y + row);
				term(clipPadAnsi("", width));
			}
			return;
		}

		const agent = this.#registry.get(this.#agentId);
		const events = agent?.events ?? [];
		const allLines = getRenderedRpcLines(events, width, { alignLogTags: true });

		const maxScrollTop = Math.max(0, allLines.length - height);
		const scrollTop = this.#followTail ? maxScrollTop : Math.max(0, Math.min(maxScrollTop, this.#scrollTop));
		this.#scrollTop = scrollTop;
		this.#followTail = scrollTop === maxScrollTop;
		const lines = allLines.slice(scrollTop, scrollTop + height);

		for (let row = 0; row < height; row += 1) {
			term.moveTo(region.x, region.y + row);
			term(clipPadAnsi(lines[row] ?? "", width));
		}
	}
}
