import type { AgentRole, OmsConfig, ThinkingLevel } from "../../config";
import { BG, clipAnsi, FG, RESET, RESET_FG, visibleWidth } from "../colors";

type TerminalLike = {
	moveTo: (x: number, y: number) => void;
	(text: string): void;
};

type Region = {
	x: number;
	y: number;
	width: number;
	height: number;
};

type SettingRow = {
	label: string;
	getValue: () => string;
	change?: (delta: 1 | -1) => void;
	readOnly?: boolean;
};

const MODEL_OPTIONS = ["codex", "haiku", "sonnet", "opus"] as const;
const THINKING_OPTIONS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ROLE_ORDER: readonly Exclude<AgentRole, "singularity">[] = [
	"worker",
	"issuer",
	"finisher",
	"steering",
	"designer-worker",
];

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function clipPadAnsi(text: string, width: number): string {
	if (width <= 0) return "";
	const clipped = clipAnsi(text, width);
	const vw = visibleWidth(clipped);
	if (vw >= width) return `${clipped}${RESET}`;
	return `${clipped}${RESET}${" ".repeat(width - vw)}`;
}

function clipPadText(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text.padEnd(width, " ");
	if (width <= 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

function cycleOption<T extends string>(current: string, options: readonly T[], delta: 1 | -1): T {
	const len = options.length;
	if (len === 0) throw new Error("cycleOption requires at least one option");

	const currentIndex = options.indexOf(current as T);
	const baseIndex = currentIndex >= 0 ? currentIndex : 0;
	const nextIndex = (baseIndex + delta + len) % len;
	return options[nextIndex]!;
}

function roleLabel(role: AgentRole): string {
	switch (role) {
		case "worker":
			return "worker";
		case "issuer":
			return "issuer";
		case "finisher":
			return "finisher";
		case "steering":
			return "steering";
		case "designer-worker":
			return "designer-worker";
		case "singularity":
			return "singularity";
		default:
			return role;
	}
}

export class SettingsPane {
	readonly #config: OmsConfig;
	readonly #onClose: () => void;
	readonly #onLayoutChanged?: (layout: OmsConfig["layout"]) => void;
	readonly #onPollIntervalChanged?: (intervalMs: number) => void;

	#selectedIndex = 0;
	#scrollTop = 0;

	constructor(opts: {
		config: OmsConfig;
		onClose: () => void;
		onLayoutChanged?: (layout: OmsConfig["layout"]) => void;
		onPollIntervalChanged?: (intervalMs: number) => void;
	}) {
		this.#config = opts.config;
		this.#onClose = opts.onClose;
		this.#onLayoutChanged = opts.onLayoutChanged;
		this.#onPollIntervalChanged = opts.onPollIntervalChanged;
	}

	handleKey(name: string): boolean {
		if (name === "ESCAPE" || name === "ESC") {
			this.#onClose();
			return true;
		}

		switch (name) {
			case "UP":
				this.#moveSelection(-1);
				return true;
			case "DOWN":
				this.#moveSelection(1);
				return true;
			case "LEFT":
				this.#changeSelected(-1);
				return true;
			case "RIGHT":
			case "ENTER":
			case "KP_ENTER":
				this.#changeSelected(1);
				return true;
			default:
				return false;
		}
	}

	render(term: TerminalLike, region: Region): void {
		const width = Math.max(0, region.width);
		const height = Math.max(0, region.height);
		if (width <= 0 || height <= 0) return;

		for (let row = 0; row < height; row += 1) {
			term.moveTo(region.x, region.y + row);
			term(`${BG.statusLine}${" ".repeat(width)}${RESET}`);
		}

		const minModalWidth = Math.min(58, width);
		const minModalHeight = Math.min(14, height);
		const modalWidth = clampInt(Math.round(width * 0.84), minModalWidth, width);
		const modalHeight = clampInt(Math.round(height * 0.88), minModalHeight, height);

		if (modalWidth < 6 || modalHeight < 6) return;

		const modalX = region.x + Math.floor((width - modalWidth) / 2);
		const modalY = region.y + Math.floor((height - modalHeight) / 2);
		const innerWidth = modalWidth - 2;

		const writeInnerLine = (rowOffset: number, text: string) => {
			if (rowOffset <= 0 || rowOffset >= modalHeight - 1) return;
			term.moveTo(modalX + 1, modalY + rowOffset);
			term(clipPadAnsi(text, innerWidth));
		};

		const title = " Settings ";
		const titleText = clipAnsi(`${FG.accent}${title}${RESET_FG}`, innerWidth);
		const titleVW = visibleWidth(titleText);
		const topFill = Math.max(0, innerWidth - titleVW);

		term.moveTo(modalX, modalY);
		term(`${FG.border}┌${titleText}${"─".repeat(topFill)}┐${RESET_FG}`);

		for (let row = 1; row < modalHeight - 1; row += 1) {
			term.moveTo(modalX, modalY + row);
			term(`${FG.border}│${RESET_FG}${" ".repeat(innerWidth)}${FG.border}│${RESET_FG}`);
		}

		term.moveTo(modalX, modalY + modalHeight - 1);
		term(`${FG.border}└${"─".repeat(innerWidth)}┘${RESET_FG}`);

		const rows = this.#buildRows();
		this.#ensureSelection(rows.length);

		const helpLine = `${FG.dim}↑↓ navigate  ←→ / Enter change  Esc close${RESET_FG}`;
		writeInnerLine(1, helpLine);

		const listTop = 2;
		const listHeight = Math.max(1, modalHeight - 3);

		if (this.#selectedIndex < this.#scrollTop) this.#scrollTop = this.#selectedIndex;
		if (this.#selectedIndex >= this.#scrollTop + listHeight) {
			this.#scrollTop = this.#selectedIndex - listHeight + 1;
		}

		const maxScrollTop = Math.max(0, rows.length - listHeight);
		this.#scrollTop = clampInt(this.#scrollTop, 0, maxScrollTop);

		const labelWidth = clampInt(Math.floor(innerWidth * 0.56), 14, Math.max(14, innerWidth - 8));

		for (let row = 0; row < listHeight; row += 1) {
			const index = this.#scrollTop + row;
			const setting = rows[index];
			if (!setting) {
				writeInnerLine(listTop + row, "");
				continue;
			}

			const selected = index === this.#selectedIndex;
			const marker = selected ? `${FG.accent}›${RESET_FG}` : " ";
			const labelColor = selected ? FG.accent : FG.muted;
			const valueColor = setting.readOnly ? FG.dim : FG.success;
			const suffix = setting.readOnly ? `${FG.dim} (read-only)${RESET_FG}` : "";

			const label = clipPadText(setting.label, labelWidth);
			const line = `${marker} ${labelColor}${label}${RESET_FG} ${valueColor}${setting.getValue()}${RESET_FG}${suffix}`;
			writeInnerLine(listTop + row, line);
		}
	}

	#moveSelection(delta: number): void {
		const rows = this.#buildRows();
		if (rows.length === 0) {
			this.#selectedIndex = 0;
			return;
		}

		const next = clampInt(this.#selectedIndex + delta, 0, rows.length - 1);
		this.#selectedIndex = next;
	}

	#changeSelected(delta: 1 | -1): void {
		const rows = this.#buildRows();
		this.#ensureSelection(rows.length);
		const row = rows[this.#selectedIndex];
		row?.change?.(delta);
	}

	#ensureSelection(length: number): void {
		if (length <= 0) {
			this.#selectedIndex = 0;
			this.#scrollTop = 0;
			return;
		}

		this.#selectedIndex = clampInt(this.#selectedIndex, 0, length - 1);
	}

	#buildRows(): SettingRow[] {
		const rows: SettingRow[] = [];

		for (const role of ROLE_ORDER) {
			const roleCfg = this.#config.roles[role];
			rows.push({
				label: `${roleLabel(role)} model`,
				getValue: () => roleCfg.model,
				change: delta => {
					roleCfg.model = cycleOption(roleCfg.model, MODEL_OPTIONS, delta);
				},
			});
		}

		for (const role of ROLE_ORDER) {
			const roleCfg = this.#config.roles[role];
			rows.push({
				label: `${roleLabel(role)} thinking`,
				getValue: () => roleCfg.thinking,
				change: delta => {
					roleCfg.thinking = cycleOption(roleCfg.thinking, THINKING_OPTIONS, delta);
				},
			});
		}

		rows.push({
			label: "maxWorkers",
			getValue: () => String(this.#config.maxWorkers),
			change: delta => {
				const step = delta > 0 ? 1 : -1;
				this.#config.maxWorkers = clampInt(this.#config.maxWorkers + step, 1, 10);
			},
		});

		rows.push({
			label: "layout.tasksHeightRatio",
			getValue: () => this.#config.layout.tasksHeightRatio.toFixed(2),
			change: delta => {
				const step = delta > 0 ? 0.05 : -0.05;
				this.#config.layout.tasksHeightRatio = round2(clamp(this.#config.layout.tasksHeightRatio + step, 0, 1));
				this.#onLayoutChanged?.(this.#config.layout);
			},
		});

		rows.push({
			label: "layout.agentsWidthRatio",
			getValue: () => this.#config.layout.agentsWidthRatio.toFixed(2),
			change: delta => {
				const step = delta > 0 ? 0.05 : -0.05;
				this.#config.layout.agentsWidthRatio = round2(clamp(this.#config.layout.agentsWidthRatio + step, 0, 1));
				this.#onLayoutChanged?.(this.#config.layout);
			},
		});

		rows.push({
			label: "layout.systemHeightRatio",
			getValue: () => this.#config.layout.systemHeightRatio.toFixed(2),
			change: delta => {
				const step = delta > 0 ? 0.05 : -0.05;
				this.#config.layout.systemHeightRatio = round2(clamp(this.#config.layout.systemHeightRatio + step, 0, 1));
				this.#onLayoutChanged?.(this.#config.layout);
			},
		});

		rows.push({
			label: "pollIntervalMs",
			getValue: () => String(this.#config.pollIntervalMs),
			change: delta => {
				const step = delta > 0 ? 250 : -250;
				const next = clampInt(this.#config.pollIntervalMs + step, 100, 120_000);
				this.#config.pollIntervalMs = next;
				this.#onPollIntervalChanged?.(next);
			},
		});

		rows.push({
			label: "steeringIntervalMs",
			getValue: () => String(this.#config.steeringIntervalMs),
			change: delta => {
				const step = delta > 0 ? 60_000 : -60_000;
				this.#config.steeringIntervalMs = clampInt(
					this.#config.steeringIntervalMs + step,
					1_000,
					24 * 60 * 60 * 1000,
				);
			},
		});

		return rows;
	}
}
