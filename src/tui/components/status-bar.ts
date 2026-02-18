import { BG, clipAnsi, FG, ICON, RESET, RESET_FG, visibleWidth } from "../colors";

export type StatusBarState = {
	autoSwitchEnabled: boolean;
	workersCount: number;
	readyCount: number;
	loopPaused: boolean;
	mouseCaptureEnabled: boolean;
	profilingActive: boolean;
	omsMessagesVisible: boolean;
};

function formatClockHHMM(d: Date): string {
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

export function renderStatusBar(state: StatusBarState, width: number): string {
	if (width <= 0) return "";

	const dot = ` ${FG.dim}${ICON.dot}${RESET_FG} `;

	// Mode indicator with semantic color
	const modeColor = state.loopPaused ? FG.warning : state.autoSwitchEnabled ? FG.success : FG.accent;
	const modeText = state.loopPaused ? "PAUSED" : state.autoSwitchEnabled ? "AUTO" : "MANUAL";
	const mode = `${modeColor}${modeText}${RESET_FG}`;

	// Counts
	const workers = `${FG.dim}W:${RESET_FG}${state.workersCount}`;
	const ready = `${FG.dim}R:${RESET_FG}${state.readyCount}`;

	// Keybind hints (compact)
	const keys = `${FG.dim}SA-↑↓${RESET_FG} Tasks ${FG.dim}SA-←→${RESET_FG} Agent ${FG.dim}SA-S${RESET_FG} Stop ${FG.dim}SA-X${RESET_FG} StopAll ${FG.dim}SA-C${RESET_FG} ToggleClosed ${FG.dim}SA-D${RESET_FG} Done ${FG.dim}SA-A${RESET_FG} Auto ${FG.dim}SA-M${RESET_FG} Mouse ${FG.dim}SA-O${RESET_FG} OMS ${FG.dim}SA-Q${RESET_FG} Quit`;
	// Clock
	const clock = `${FG.dim}${formatClockHHMM(new Date())}${RESET_FG}`;

	// Assemble left side
	const leftParts = [mode, workers, ready, keys];
	if (state.profilingActive) {
		leftParts.push(`${FG.error}● PROFILING${RESET_FG}`);
	}
	const left = leftParts.join(dot);

	// Calculate padding between left and clock
	const clockVW = visibleWidth(clock);
	if (width <= clockVW) {
		const clippedClock = clipAnsi(clock, width);
		const finalPad = Math.max(0, width - visibleWidth(clippedClock));
		return `${BG.statusLine}${clippedClock}${" ".repeat(finalPad)}${RESET}`;
	}

	const leftMaxVW = Math.max(0, width - clockVW - 1);
	const leftClipped = clipAnsi(left, leftMaxVW);
	const leftVW = visibleWidth(leftClipped);
	const gap = Math.max(1, width - leftVW - clockVW);
	const content = `${leftClipped}${" ".repeat(gap)}${clock}`;

	// Pad to full width for background coverage
	const contentVW = visibleWidth(content);
	const finalPad = Math.max(0, width - contentVW);

	return `${BG.statusLine}${content}${" ".repeat(finalPad)}${RESET}`;
}
