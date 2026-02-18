export type KeybindContext<TState> = {
	getState: () => TState;
	setState: (updater: (prev: TState) => TState) => void;
	quit: () => void;
	actions?: {
		selectTasksDelta?: (delta: number) => void;
		selectAgentDelta?: (delta: number, currentAgentId: string | null) => void;
		stopSelected?: () => void;
		stopAll?: () => void;
		toggleTasksClosed?: () => void;
		toggleDoneAgents?: () => void;
		toggleMouseCapture?: () => void;
		toggleProfiling?: () => void;
		toggleSettings?: () => void;
	};
};

export type KeybindHandler<TState> = (ctx: KeybindContext<TState>) => void;

export class KeybindDispatcher<TState> {
	readonly #handlers = new Map<string, KeybindHandler<TState>>();

	bind(keyName: string | readonly string[], handler: KeybindHandler<TState>): this {
		if (typeof keyName !== "string") {
			for (const name of keyName) this.#handlers.set(name, handler);
			return this;
		}

		this.#handlers.set(keyName, handler);
		return this;
	}

	dispatch(keyName: string, ctx: KeybindContext<TState>): boolean {
		const handler = this.#handlers.get(keyName);
		if (!handler) return false;

		handler(ctx);
		return true;
	}
}

export type OmsTuiUiState = {
	autoSwitchEnabled: boolean;
	activeAgentId: string | null;
	workersCount: number;
	readyCount: number;
	loopPaused: boolean;
	mouseCaptureEnabled: boolean;
	profilingActive: boolean;
};

export function registerOmsTuiKeybinds(dispatcher: KeybindDispatcher<OmsTuiUiState>): void {
	dispatcher.bind(["SHIFT_ALT_Q", "ALT_SHIFT_Q"], ctx => ctx.quit());

	// Fallback quit
	dispatcher.bind(["CTRL_Q", "CTRL+Q"], ctx => ctx.quit());

	// Fallback quit (useful when Ctrl+Q is intercepted by terminal flow control).
	dispatcher.bind(["CTRL_C", "CTRL+C"], ctx => ctx.quit());

	// Agent swap
	dispatcher.bind(["SHIFT_ALT_LEFT", "ALT_SHIFT_LEFT"], ctx => {
		ctx.actions?.selectAgentDelta?.(-1, ctx.getState().activeAgentId);
	});

	dispatcher.bind(["SHIFT_ALT_RIGHT", "ALT_SHIFT_RIGHT"], ctx => {
		ctx.actions?.selectAgentDelta?.(1, ctx.getState().activeAgentId);
	});

	// Tasks selection
	dispatcher.bind(["SHIFT_ALT_UP", "ALT_SHIFT_UP"], ctx => {
		ctx.actions?.selectTasksDelta?.(-1);
	});

	dispatcher.bind(["SHIFT_ALT_DOWN", "ALT_SHIFT_DOWN"], ctx => {
		ctx.actions?.selectTasksDelta?.(1);
	});

	// Stop controls
	dispatcher.bind(["SHIFT_ALT_S", "ALT_SHIFT_S"], ctx => {
		ctx.actions?.stopSelected?.();
	});

	dispatcher.bind(["SHIFT_ALT_X", "ALT_SHIFT_X"], ctx => {
		ctx.actions?.stopAll?.();
	});

	dispatcher.bind(["SHIFT_ALT_C", "ALT_SHIFT_C"], ctx => {
		ctx.actions?.toggleTasksClosed?.();
	});

	dispatcher.bind(["SHIFT_ALT_D", "ALT_SHIFT_D"], ctx => {
		ctx.actions?.toggleDoneAgents?.();
	});

	dispatcher.bind(["SHIFT_ALT_M", "ALT_SHIFT_M"], ctx => {
		ctx.actions?.toggleMouseCapture?.();
	});

	// Render profiling toggle
	dispatcher.bind(["SHIFT_ALT_P", "ALT_SHIFT_P"], ctx => {
		ctx.actions?.toggleProfiling?.();
	});

	// Settings overlay toggle
	dispatcher.bind(["SHIFT_ALT_O", "ALT_SHIFT_O"], ctx => {
		ctx.actions?.toggleSettings?.();
	});

	// Agent pane auto-switch toggle (kept, but moved off Shift+Alt+Up)
	dispatcher.bind(["SHIFT_ALT_A", "ALT_SHIFT_A"], ctx => {
		ctx.setState(prev => ({
			...prev,
			autoSwitchEnabled: !prev.autoSwitchEnabled,
		}));
	});
}
