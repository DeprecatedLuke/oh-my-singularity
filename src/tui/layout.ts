export type Region = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type Layout = {
	tasks: Region;
	selected: Region;
	singularity: Region;
	system: Region;
	agents: Region;
	statusBar: Region;
};

export type ComputeLayoutOptions = {
	/** Height ratio (0..1) for the Tasks pane (top). Default: 0.25 */
	tasksHeightRatio?: number;

	/** Width ratio (0..1) for the Agents pane (right). Default: 0.45 */
	agentsWidthRatio?: number;

	/** Height ratio (0..1) of the singularity area reserved for the OMS/system pane. Default: 0.30 */
	systemHeightRatio?: number;

	/** Minimum height of Tasks pane (rows). Default: 5 */
	minTasksHeight?: number;

	/** Minimum height of bottom panes (rows). Default: 8 */
	minBottomHeight?: number;

	/** Minimum width of Agents pane (cols). Default: 20 */
	minAgentsWidth?: number;

	/** Minimum width of Singularity pane (cols). Default: 30 */
	minCenterWidth?: number;

	statusBarHeight?: number;
};

function clampInt(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function computeLayout(
	columnsInput: number | undefined,
	rowsInput: number | undefined,
	opts: ComputeLayoutOptions = {},
): Layout {
	const columns = clampInt(columnsInput ?? 80, 1, Number.MAX_SAFE_INTEGER);
	const rows = clampInt(rowsInput ?? 24, 1, Number.MAX_SAFE_INTEGER);

	const statusBarHeight = clampInt(opts.statusBarHeight ?? 1, 0, rows);
	const contentRows = Math.max(0, rows - statusBarHeight);

	// Layout:
	// - Tasks pane on top-left (height ratio)
	// - Selected pane on top-right
	// - Singularity pane bottom-left (top portion)
	// - System pane bottom-left (bottom portion, systemHeightRatio of bottom-left)
	// - Agents pane bottom-right (width ratio)
	const tasksRatioRaw = typeof opts.tasksHeightRatio === "number" ? opts.tasksHeightRatio : 0.25;
	const tasksRatio = Math.max(0, Math.min(1, tasksRatioRaw));

	const agentsRatioRaw = typeof opts.agentsWidthRatio === "number" ? opts.agentsWidthRatio : 0.45;
	const agentsRatio = Math.max(0, Math.min(1, agentsRatioRaw));

	const minTasksHeight = clampInt(opts.minTasksHeight ?? 5, 0, contentRows);
	const minBottomHeight = clampInt(opts.minBottomHeight ?? 8, 0, contentRows);

	const desiredTasksHeight = Math.round(contentRows * tasksRatio);
	let tasksHeight = clampInt(desiredTasksHeight, 0, contentRows);

	// Preserve space for bottom panes.
	if (contentRows > 0) {
		tasksHeight = Math.max(tasksHeight, minTasksHeight);
		tasksHeight = Math.min(tasksHeight, Math.max(0, contentRows - minBottomHeight));
	}

	const bottomHeight = Math.max(0, contentRows - tasksHeight);

	const minAgentsWidth = clampInt(opts.minAgentsWidth ?? 20, 0, columns);
	const minCenterWidth = clampInt(opts.minCenterWidth ?? 30, 1, columns);

	const desiredAgentsWidth = Math.round(columns * agentsRatio);
	let agentsWidth = clampInt(desiredAgentsWidth, 0, columns);
	agentsWidth = Math.max(agentsWidth, minAgentsWidth);
	agentsWidth = Math.min(agentsWidth, Math.max(0, columns - minCenterWidth));

	const centerWidth = Math.max(0, columns - agentsWidth);

	const tasks: Region = { x: 1, y: 1, width: centerWidth, height: tasksHeight };
	const selected: Region = {
		x: centerWidth + 1,
		y: 1,
		width: agentsWidth,
		height: tasksHeight,
	};
	// Split the bottom-left area into singularity (top) and system (bottom).
	const systemRatioRaw = typeof opts.systemHeightRatio === "number" ? opts.systemHeightRatio : 0.3;
	const systemRatio = Math.max(0, Math.min(1, systemRatioRaw));
	const systemHeight = clampInt(Math.round(bottomHeight * systemRatio), 0, bottomHeight);
	const singularityHeight = Math.max(0, bottomHeight - systemHeight);
	const singularity: Region = {
		x: 1,
		y: tasksHeight + 1,
		width: centerWidth,
		height: singularityHeight,
	};
	const system: Region = {
		x: 1,
		y: tasksHeight + singularityHeight + 1,
		width: centerWidth,
		height: systemHeight,
	};
	const agents: Region = {
		x: centerWidth + 1,
		y: tasksHeight + 1,
		width: agentsWidth,
		height: bottomHeight,
	};
	const statusBar: Region = {
		x: 1,
		y: contentRows + 1,
		width: columns,
		height: statusBarHeight,
	};

	return { tasks, selected, singularity, system, agents, statusBar };
}
