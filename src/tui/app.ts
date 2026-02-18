import terminalKit from "terminal-kit";

// Work around Bun TTY resize quirks: prefer SIGWINCH over tty 'resize' events.
// This avoids occasional ioctl(2) EBADF crashes when listening to stdout resize.
const tkAny = terminalKit as any;
if (tkAny.globalConfig && typeof tkAny.globalConfig === "object") {
	tkAny.globalConfig.preferProcessSigwinch = true;
}

import { logger } from "../utils";
import { renderStatusBar } from "./components/status-bar";
import { KeybindDispatcher, type OmsTuiUiState, registerOmsTuiKeybinds } from "./keybinds";
import type { ComputeLayoutOptions, Layout, Region } from "./layout";
import { computeLayout } from "./layout";
import { RenderProfiler } from "./profiler";

type Pane = {
	getTitle?: (state?: unknown) => string | undefined;

	render: (term: TerminalLike, region: Region, state?: unknown) => void;
	handleKey?: (name: string, data: any) => boolean;
	handleMouse?: (name: string, data: any, region: Region, state?: unknown) => boolean;
	resize?: (cols: number, rows: number) => void;
	stop?: () => void;
};

type TerminalLike = {
	width?: number;
	height?: number;
	clear: () => void;
	moveTo: (x: number, y: number) => void;
	grabInput: (options: unknown) => void;
	fullscreen: (enable: boolean) => void;
	hideCursor: () => void;
	showCursor: () => void;
	styleReset: () => void;
	on: (event: string, listener: (...args: any[]) => void) => void;
	off?: (event: string, listener: (...args: any[]) => void) => void;
	removeListener?: (event: string, listener: (...args: any[]) => void) => void;
	eraseLine: () => void;
	(text: string): void;
};

function detachListener(term: TerminalLike, event: string, listener: (...args: any[]) => void): void {
	if (term.off) {
		term.off(event, listener);
		return;
	}

	if (term.removeListener) {
		term.removeListener(event, listener);
	}
}

function repeatChar(ch: string, count: number): string {
	if (count <= 0) return "";
	return ch.repeat(count);
}

function drawBox(term: TerminalLike, region: Region, title: string): void {
	if (region.width <= 0 || region.height <= 0) return;
	const w = region.width;
	const h = region.height;
	// Too small for a full box: best-effort line.
	if (w < 2 || h < 2) {
		term.moveTo(region.x, region.y);
		term(repeatChar("#", w));
		return;
	}

	const bc = "\x1b[38;2;23;143;185m"; // border blue (#178fb9)
	const rf = "\x1b[39m"; // reset fg

	// Top: ┌──────── Title ─────────┐
	const titleLabel = title ? ` ${title} ` : "";
	const titleMax = Math.max(0, w - 4);
	const clippedTitle = titleLabel.slice(0, titleMax);
	const dashTotal = Math.max(0, w - 2 - clippedTitle.length);
	const leftDash = Math.floor(dashTotal / 2);
	const rightDash = dashTotal - leftDash;
	const topLine = `${bc}┌${repeatChar("─", leftDash)}${rf}${clippedTitle}${bc}${repeatChar("─", rightDash)}┐${rf}`;

	term.moveTo(region.x, region.y);
	term(topLine);
	for (let row = 1; row < h - 1; row += 1) {
		term.moveTo(region.x, region.y + row);
		term(`${bc}│${rf}`);
		term.moveTo(region.x + w - 1, region.y + row);
		term(`${bc}│${rf}`);
	}

	// Bottom: └────────────────────────┘
	const bottomLine = `${bc}└${repeatChar("─", w - 2)}┘${rf}`;
	term.moveTo(region.x, region.y + h - 1);
	term(bottomLine);
}

function drawStatusBar(term: TerminalLike, region: Region, text: string): void {
	if (region.height <= 0 || region.width <= 0) return;
	term.moveTo(region.x, region.y);
	term.eraseLine();
	term(text);
}

function createBufferedTerm(): TerminalLike & { getBuffer(): string } {
	let buf = "";
	const noop = () => {};
	const fn: any = (text: string) => {
		buf += text;
	};
	fn.moveTo = (x: number, y: number) => {
		buf += `\x1b[${y};${x}H`;
	};
	fn.eraseLine = () => {
		buf += "\x1b[2K";
	};
	fn.clear = () => {
		buf += "\x1b[2J\x1b[H";
	};
	fn.grabInput = noop;
	fn.fullscreen = noop;
	fn.hideCursor = noop;
	fn.showCursor = noop;
	fn.styleReset = noop;
	fn.on = noop;
	fn.getBuffer = () => buf;
	return fn as TerminalLike & { getBuffer(): string };
}

function regionContains(region: Region, x: number, y: number): boolean {
	if (region.width <= 0 || region.height <= 0) return false;
	return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}

export class OmsTuiApp {
	readonly #term: TerminalLike;
	#layout: Layout;
	#running = false;
	readonly #onQuit?: () => void;
	readonly #layoutOpts: ComputeLayoutOptions;
	#savedSystemHeightRatio: number | undefined;

	#lastCols: number;
	#lastRows: number;
	#sizePoller: Timer | null = null;
	#fullRedrawPoller: Timer | null = null;
	#staticRefreshTimer: Timer | null = null;

	#redrawScheduled = false;
	#redrawTimer: Timer | null = null;

	#fullClearPending = true;
	#bordersDirty = true;
	#lastAgentsTitle = "";
	#lastRedrawAt = 0;
	readonly #minRedrawIntervalMs = 16;
	readonly #fullRedrawIntervalMs = 45_000;
	#mouseCaptureEnabled = true;
	readonly #profiler = new RenderProfiler();

	#activeAgentResolver?: (currentId: string | null, autoSwitch: boolean) => string | null;
	#hasActiveTasksChecker?: () => boolean;

	#uiState: OmsTuiUiState = {
		autoSwitchEnabled: true,
		activeAgentId: null as string | null,
		workersCount: 0,
		readyCount: 0,
		loopPaused: false,
		mouseCaptureEnabled: true,
		profilingActive: false,
		omsMessagesVisible: false,
	};

	readonly #keybinds = new KeybindDispatcher<OmsTuiUiState>();

	#keybindActions:
		| {
				selectTasksDelta?: (delta: number) => void;
				selectAgentDelta?: (delta: number, currentAgentId: string | null) => void;
				stopSelected?: () => void;
				stopAll?: () => void;
				toggleTasksClosed?: () => void;
				toggleDoneAgents?: () => void;
				toggleMouseCapture?: () => void;
				toggleProfiling?: () => void;
				toggleOmsMessages?: () => void;
				toggleSettings?: () => void;
		  }
		| undefined;

	#panes: {
		tasks?: Pane;
		selected?: Pane;
		singularity?: Pane;
		agents?: Pane;
		system?: Pane;
	} = {};
	#settingsPane: Pane | undefined;
	#settingsOpen = false;

	readonly #onKey = (name: string, _matches: unknown, _data: any) => {
		const ctx = {
			getState: () => this.#uiState,
			setState: (updater: (prev: OmsTuiUiState) => OmsTuiUiState) => {
				this.#uiState = updater(this.#uiState);
			},
			quit: () => {
				this.quit();
			},
			actions: this.#keybindActions,
		};
		if (this.#settingsOpen) {
			const allowGlobal =
				name === "SHIFT_ALT_O" ||
				name === "ALT_SHIFT_O" ||
				name === "SHIFT_ALT_L" ||
				name === "ALT_SHIFT_L" ||
				name === "SHIFT_ALT_Q" ||
				name === "ALT_SHIFT_Q" ||
				name === "CTRL_Q" ||
				name === "CTRL+Q" ||
				name === "CTRL_C" ||
				name === "CTRL+C";

			if (allowGlobal) {
				const handled = this.#keybinds.dispatch(name, ctx);
				if (handled && this.#running) this.#redraw();
				return;
			}
			const modalHandled = this.#settingsPane?.handleKey?.(name, _data) ?? false;
			if (modalHandled && this.#running) this.#redraw();
			return;
		}

		const handled = this.#keybinds.dispatch(name, ctx);
		if (handled && this.#running) {
			this.#redraw();
			return;
		}
		// Default focus is center pane: forward unhandled keys.
		const forwarded = this.#panes.singularity?.handleKey?.(name, _data) ?? false;
		if (forwarded) return;
	};

	readonly #onMouse = (name: string, data: any) => {
		if (!this.#running) return;
		if (!this.#mouseCaptureEnabled) return;
		if (!data || typeof data.x !== "number" || typeof data.y !== "number") return;
		if (this.#settingsOpen) {
			const handled = this.#settingsPane?.handleMouse?.(name, data, overlayRegion(this.#layout)) ?? false;
			if (handled) this.#redraw();
			return;
		}

		const wheelDir = name === "MOUSE_WHEEL_UP" ? -1 : name === "MOUSE_WHEEL_DOWN" ? 1 : 0;
		if (!wheelDir) return;

		const x = data.x;
		const y = data.y;

		const tasksRegion = innerRegion(this.#layout.tasks);
		const selectedRegion = innerRegion(this.#layout.selected);
		const singularityRegion = innerRegion(this.#layout.singularity);
		const agentsRegion = innerRegion(this.#layout.agents);
		const systemRegion = innerRegion(this.#layout.system);

		if (regionContains(agentsRegion, x, y)) {
			const handled =
				this.#panes.agents?.handleMouse?.(name, data, agentsRegion, {
					activeAgentId: this.#uiState.activeAgentId,
				}) ?? false;
			if (handled) this.#redraw();
			return;
		}

		if (regionContains(tasksRegion, x, y)) {
			const handled = this.#panes.tasks?.handleMouse?.(name, data, tasksRegion) ?? false;
			if (handled) this.#redraw();
			return;
		}

		if (regionContains(selectedRegion, x, y)) {
			const handled = this.#panes.selected?.handleMouse?.(name, data, selectedRegion) ?? false;
			if (handled) this.#redraw();
			return;
		}

		if (regionContains(singularityRegion, x, y)) {
			const handled = this.#panes.singularity?.handleMouse?.(name, data, singularityRegion) ?? false;
			if (handled) this.#redraw();
		}

		if (regionContains(systemRegion, x, y)) {
			const handled = this.#panes.system?.handleMouse?.(name, data, systemRegion) ?? false;
			if (handled) this.#redraw();
		}
	};

	readonly #onResize = (width?: number, height?: number) => {
		try {
			const cols = sanitizeTermSize(width, 80);
			const rows = sanitizeTermSize(height, 24);

			this.#lastCols = cols;
			this.#lastRows = rows;

			this.#layout = computeLayout(cols, rows, this.#layoutOpts);
			this.#fullClearPending = true;
			this.#bordersDirty = true;

			// Resize singularity pane content (PTY, etc).
			const singularityInner = innerRegion(this.#layout.singularity);
			this.#panes.singularity?.resize?.(singularityInner.width, singularityInner.height);

			this.#redraw();
		} catch {
			// Never crash on resize; best-effort.
		}
	};

	constructor(
		term: TerminalLike = getDefaultTerminal(),
		opts?: { onQuit?: () => void; layout?: ComputeLayoutOptions },
	) {
		this.#term = term;
		const cols = sanitizeTermSize(this.#term.width, 80);
		const rows = sanitizeTermSize(this.#term.height, 24);
		this.#lastCols = cols;
		this.#lastRows = rows;
		this.#layoutOpts = opts?.layout ?? {};
		this.#savedSystemHeightRatio = this.#layoutOpts.systemHeightRatio;
		// If OMS messages start hidden, ensure systemHeightRatio is 0 so the pane is not visible
		if (!this.#uiState.omsMessagesVisible) {
			this.#layoutOpts.systemHeightRatio = 0;
		}
		this.#layout = computeLayout(cols, rows, this.#layoutOpts);
		this.#onQuit = opts?.onQuit;

		registerOmsTuiKeybinds(this.#keybinds);
	}

	setPanes(panes: { tasks?: Pane; selected?: Pane; singularity?: Pane; system?: Pane; agents?: Pane }): void {
		this.#panes = panes;

		// Best-effort initial resize for singularity.
		const singularityInner = innerRegion(this.#layout.singularity);
		this.#panes.singularity?.resize?.(singularityInner.width, singularityInner.height);

		if (this.#running) this.#redraw();
	}
	setSettingsPane(pane?: Pane): void {
		this.#settingsPane = pane;
		if (!pane) this.#settingsOpen = false;
		if (this.#running) this.#redraw();
	}

	setKeybindActions(actions: {
		selectTasksDelta?: (delta: number) => void;
		selectAgentDelta?: (delta: number, currentAgentId: string | null) => void;
		stopSelected?: () => void;
		stopAll?: () => void;
		toggleTasksClosed?: () => void;
		toggleDoneAgents?: () => void;
		toggleMouseCapture?: () => void;
		toggleProfiling?: () => void;
		toggleOmsMessages?: () => void;
		toggleSettings?: () => void;
	}): void {
		this.#keybindActions = actions;
	}

	setActiveAgentResolver(resolver: (currentId: string | null, autoSwitch: boolean) => string | null): void {
		this.#activeAgentResolver = resolver;
	}

	setHasActiveTasksChecker(checker: () => boolean): void {
		this.#hasActiveTasksChecker = checker;
	}

	/** Switch the agent pane to a specific agent by registry ID, disabling auto-switch. */
	focusAgent(agentId: string): void {
		this.#uiState = {
			...this.#uiState,
			autoSwitchEnabled: false,
			activeAgentId: agentId,
		};
		this.requestRedraw();
	}

	isMouseCaptureEnabled(): boolean {
		return this.#mouseCaptureEnabled;
	}

	toggleMouseCapture(): void {
		this.#mouseCaptureEnabled = !this.#mouseCaptureEnabled;
		this.#uiState = {
			...this.#uiState,
			mouseCaptureEnabled: this.#mouseCaptureEnabled,
		};

		if (this.#running) {
			try {
				this.#term.grabInput({ mouse: this.#mouseCaptureEnabled ? "button" : false });
			} catch (err) {
				logger.debug(
					'tui/app.ts: best-effort failure after this.#term.grabInput({ mouse: this.#mouseCaptureEnabled ? "button" : false });',
					{ err },
				);
			}
		}

		this.requestRedraw();
	}

	toggleProfiling(): void {
		const nowActive = this.#profiler.toggle();
		this.#uiState = {
			...this.#uiState,
			profilingActive: nowActive,
		};
		this.requestRedraw();
	}
	toggleOmsMessages(): void {
		const currentlyVisible = this.#uiState.omsMessagesVisible;
		if (currentlyVisible) {
			this.#savedSystemHeightRatio = this.#layoutOpts.systemHeightRatio;
			this.#layoutOpts.systemHeightRatio = 0;
		} else {
			this.#layoutOpts.systemHeightRatio = this.#savedSystemHeightRatio ?? 0.3;
		}
		this.#layout = computeLayout(this.#lastCols, this.#lastRows, this.#layoutOpts);
		this.#fullClearPending = true;
		this.#bordersDirty = true;
		const singularityInner = innerRegion(this.#layout.singularity);
		this.#panes.singularity?.resize?.(singularityInner.width, singularityInner.height);
		this.#uiState = {
			...this.#uiState,
			omsMessagesVisible: !currentlyVisible,
		};
		this.requestRedraw();
	}
	toggleSettings(): void {
		if (!this.#settingsPane) return;
		this.#settingsOpen = !this.#settingsOpen;
		this.#fullClearPending = true;
		this.requestRedraw();
	}

	closeSettings(): void {
		if (!this.#settingsOpen) return;
		this.#settingsOpen = false;
		this.#fullClearPending = true;
		this.requestRedraw();
	}

	setLayoutOptions(layout: { tasksHeightRatio: number; agentsWidthRatio: number; systemHeightRatio: number }): void {
		this.#layoutOpts.tasksHeightRatio = layout.tasksHeightRatio;
		this.#layoutOpts.agentsWidthRatio = layout.agentsWidthRatio;
		this.#layoutOpts.systemHeightRatio = layout.systemHeightRatio;
		this.#layout = computeLayout(this.#lastCols, this.#lastRows, this.#layoutOpts);
		this.#fullClearPending = true;
		this.#bordersDirty = true;

		const singularityInner = innerRegion(this.#layout.singularity);
		this.#panes.singularity?.resize?.(singularityInner.width, singularityInner.height);

		this.requestRedraw();
	}

	requestRedraw(): void {
		if (!this.#running) return;
		if (this.#redrawScheduled) return;

		const now = Date.now();
		const elapsed = now - this.#lastRedrawAt;
		if (elapsed >= this.#minRedrawIntervalMs) {
			this.#redraw();
			return;
		}
		this.#redrawScheduled = true;
		const delay = this.#minRedrawIntervalMs - elapsed;
		this.#redrawTimer = setTimeout(() => {
			this.#redrawScheduled = false;
			this.#redrawTimer = null;
			if (!this.#running) return;
			this.#redraw();
		}, delay);
	}

	setCounts(counts: { workersCount?: number; readyCount?: number; loopPaused?: boolean }): void {
		this.#uiState = {
			...this.#uiState,
			workersCount: counts.workersCount ?? this.#uiState.workersCount,
			readyCount: counts.readyCount ?? this.#uiState.readyCount,
			loopPaused: counts.loopPaused ?? this.#uiState.loopPaused,
		};

		this.requestRedraw();
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#fullClearPending = true;
		this.#bordersDirty = true;

		this.#term.fullscreen(true);
		this.#term.clear();
		this.#term.hideCursor();
		this.#term.grabInput({ mouse: this.#mouseCaptureEnabled ? "button" : false });

		this.#term.on("key", this.#onKey);
		this.#term.on("mouse", this.#onMouse);
		this.#term.on("resize", this.#onResize);

		// Some environments miss resize events; poll size as a backstop.
		if (!this.#sizePoller) {
			this.#sizePoller = setInterval(() => {
				this.#pollSize();
			}, 200);
		}
		if (!this.#fullRedrawPoller) {
			this.#fullRedrawPoller = setInterval(() => {
				if (!this.#running) return;
				this.#fullClearPending = true;
				this.requestRedraw();
			}, this.#fullRedrawIntervalMs);
		}
		if (!this.#staticRefreshTimer) {
			this.#staticRefreshTimer = setInterval(() => {
				if (!this.#running) return;
				if (!this.#hasActiveTasksChecker?.()) return;
				this.requestRedraw();
			}, 1000);
		}

		this.#redraw();
	}

	quit(): void {
		try {
			this.stop();
		} finally {
			// Always call onQuit even if stop() throws.
			this.#onQuit?.();
		}
	}

	stop(): void {
		if (!this.#running) return;
		this.#running = false;

		try {
			detachListener(this.#term, "key", this.#onKey);
		} catch (err) {
			logger.debug('tui/app.ts: best-effort failure after detachListener(this.#term, "key", this.#onKey);', { err });
		}
		try {
			detachListener(this.#term, "mouse", this.#onMouse);
		} catch (err) {
			logger.debug('tui/app.ts: best-effort failure after detachListener(this.#term, "mouse", this.#onMouse);', {
				err,
			});
		}
		try {
			detachListener(this.#term, "resize", this.#onResize);
		} catch (err) {
			logger.debug('tui/app.ts: best-effort failure after detachListener(this.#term, "resize", this.#onResize);', {
				err,
			});
		}

		if (this.#sizePoller) {
			clearInterval(this.#sizePoller);
			this.#sizePoller = null;
		}
		if (this.#fullRedrawPoller) {
			clearInterval(this.#fullRedrawPoller);
			this.#fullRedrawPoller = null;
		}
		if (this.#staticRefreshTimer) {
			clearInterval(this.#staticRefreshTimer);
			this.#staticRefreshTimer = null;
		}

		if (this.#redrawTimer) {
			clearTimeout(this.#redrawTimer);
			this.#redrawTimer = null;
		}
		this.#redrawScheduled = false;

		// Restore terminal state.
		try {
			this.#panes.singularity?.stop?.();
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after this.#panes.singularity?.stop?.();", { err });
		}

		try {
			this.#term.grabInput(false);
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after this.#term.grabInput(false);", { err });
		}
		try {
			this.#term.styleReset();
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after this.#term.styleReset();", { err });
		}
		try {
			this.#term.showCursor();
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after this.#term.showCursor();", { err });
		}
		try {
			this.#term.fullscreen(false);
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after this.#term.fullscreen(false);", { err });
		}
		try {
			this.#term.clear();
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after this.#term.clear();", { err });
		}
	}

	#redraw(): void {
		if (!this.#running) return;
		this.#profiler.beginFrame(this.#redrawScheduled ? 1 : 0);
		this.#lastRedrawAt = Date.now();
		const bt = createBufferedTerm();
		if (this.#fullClearPending) {
			bt.clear();
			this.#fullClearPending = false;
			this.#bordersDirty = true;
		}

		// Reconcile active agent selection before rendering.
		if (this.#activeAgentResolver) {
			const resolved = this.#activeAgentResolver(this.#uiState.activeAgentId, this.#uiState.autoSwitchEnabled);
			if (resolved !== this.#uiState.activeAgentId) {
				this.#uiState = { ...this.#uiState, activeAgentId: resolved };
			}
		}
		const agentsTitle =
			this.#panes.agents?.getTitle?.({
				activeAgentId: this.#uiState.activeAgentId,
			}) ?? "Agents";
		if (agentsTitle !== this.#lastAgentsTitle) {
			this.#bordersDirty = true;
			this.#lastAgentsTitle = agentsTitle;
		}
		this.#profiler.startPhase("borders");
		if (this.#bordersDirty) {
			this.#profiler.markBordersRedrawn();
			drawBox(bt, this.#layout.tasks, "Tasks");
			drawBox(bt, this.#layout.selected, "Selected Task");
			drawBox(bt, this.#layout.singularity, "Singularity");
			drawBox(bt, this.#layout.system, "OMS/System");
			drawBox(bt, this.#layout.agents, agentsTitle);
			this.#bordersDirty = false;
		}

		this.#profiler.startPhase("pane:tasks");
		try {
			this.#panes.tasks?.render(bt, innerRegion(this.#layout.tasks));
		} catch (err) {
			logger.debug(
				"tui/app.ts: best-effort failure after this.#panes.tasks?.render(bt, innerRegion(this.#layout.tasks));",
				{ err },
			);
		}

		this.#profiler.startPhase("pane:selected");
		try {
			this.#panes.selected?.render(bt, innerRegion(this.#layout.selected));
		} catch (err) {
			logger.debug(
				"tui/app.ts: best-effort failure after this.#panes.selected?.render(bt, innerRegion(this.#layout.selected));",
				{ err },
			);
		}

		this.#profiler.startPhase("pane:singularity");
		try {
			this.#panes.singularity?.render(bt, innerRegion(this.#layout.singularity));
		} catch (err) {
			logger.debug(
				"tui/app.ts: best-effort failure after this.#panes.singularity?.render(bt, innerRegion(this.#layout.singularity));",
				{ err },
			);
		}

		this.#profiler.startPhase("pane:agents");
		try {
			this.#panes.agents?.render(bt, innerRegion(this.#layout.agents), {
				activeAgentId: this.#uiState.activeAgentId,
			});
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after });", { err });
		}

		this.#profiler.startPhase("pane:system");
		try {
			this.#panes.system?.render(bt, innerRegion(this.#layout.system), {
				omsMessagesVisible: this.#uiState.omsMessagesVisible,
			});
		} catch (err) {
			logger.debug(
				"tui/app.ts: best-effort failure after this.#panes.system?.render(bt, innerRegion(this.#layout.system));",
				{ err },
			);
		}
		this.#profiler.startPhase("statusBar");
		drawStatusBar(bt, this.#layout.statusBar, renderStatusBar(this.#uiState, this.#layout.statusBar.width));
		if (this.#settingsOpen && this.#settingsPane) {
			this.#profiler.startPhase("pane:settings");
			try {
				this.#settingsPane.render(bt, overlayRegion(this.#layout));
			} catch (err) {
				logger.debug(
					"tui/app.ts: best-effort failure after this.#settingsPane.render(bt, overlayRegion(this.#layout));",
					{ err },
				);
			}
		}
		// Park cursor at the status bar to avoid blinking inside panes.
		bt.moveTo(1, this.#layout.statusBar.y);
		this.#profiler.startPhase("termWrite");
		const buf = bt.getBuffer();
		if (buf) this.#term(buf);
		this.#profiler.endFrame(buf ? buf.length : 0);
	}

	#pollSize(): void {
		if (!this.#running) return;

		let cols = sanitizeTermSize(this.#term.width, 80);
		let rows = sanitizeTermSize(this.#term.height, 24);

		// Prefer querying the underlying tty stream (realTerminal) if available.
		try {
			const out = (this.#term as any).stdout;
			if (out && typeof out.getWindowSize === "function") {
				const size = out.getWindowSize();
				if (Array.isArray(size) && size.length >= 2) {
					cols = sanitizeTermSize(size[0], cols);
					rows = sanitizeTermSize(size[1], rows);
				}
			}
		} catch (err) {
			logger.debug("tui/app.ts: best-effort failure after rows = sanitizeTermSize(size[1], rows);", { err });
		}

		// Extra fallback: some terminals update process.stdout columns/rows even when term.width isn't.
		try {
			cols = sanitizeTermSize((process.stdout as any).columns, cols);
			rows = sanitizeTermSize((process.stdout as any).rows, rows);
		} catch (err) {
			logger.debug(
				"tui/app.ts: best-effort failure after rows = sanitizeTermSize((process.stdout as any).rows, rows);",
				{ err },
			);
		}

		if (cols === this.#lastCols && rows === this.#lastRows) return;
		this.#lastCols = cols;
		this.#lastRows = rows;

		this.#layout = computeLayout(cols, rows, this.#layoutOpts);
		this.#fullClearPending = true;
		this.#bordersDirty = true;
		const singularityInner = innerRegion(this.#layout.singularity);
		this.#panes.singularity?.resize?.(singularityInner.width, singularityInner.height);
		this.#redraw();
	}
}

function innerRegion(region: Region): Region {
	return {
		x: region.x + 1,
		y: region.y + 1,
		width: Math.max(0, region.width - 2),
		height: Math.max(0, region.height - 2),
	};
}
function overlayRegion(layout: Layout): Region {
	return {
		x: layout.statusBar.x,
		y: 1,
		width: layout.statusBar.width,
		height: Math.max(1, layout.statusBar.y + layout.statusBar.height - 1),
	};
}

function sanitizeTermSize(value: unknown, fallback: number): number {
	if (typeof value !== "number") return fallback;
	if (!Number.isFinite(value)) return fallback;
	if (value <= 0) return fallback;
	return Math.trunc(value);
}

function getDefaultTerminal(): TerminalLike {
	// Prefer terminal-kit realTerminal (uses /dev/tty) because Bun's stdio TTY
	// wrappers can occasionally throw ioctl EBADF on resize.
	try {
		const rt = (terminalKit as any).realTerminal;
		if (rt) return rt as TerminalLike;
	} catch (err) {
		logger.debug("tui/app.ts: best-effort failure after if (rt) return rt as TerminalLike;", { err });
	}

	return (terminalKit as any).terminal as TerminalLike;
}
