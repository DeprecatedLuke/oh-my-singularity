import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import type { AgentRegistry } from "../agents/registry";
import type { AgentSpawner } from "../agents/spawner";
import type { OmsConfig } from "../config";
import { handleIpcMessage } from "../ipc/handlers";
import { startOmsSingularityIpcServer } from "../ipc/server";
import { AgentLoop } from "../loop/agent-loop";
import type { Scheduler } from "../loop/scheduler";
import type { SessionLogWriter } from "../session-log-writer";
import { getSrcDir, probeExtensionLoad, resolveSingularityExtensionCandidates } from "../setup/extensions";
import { setupShutdownHandlers } from "../shutdown";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskPollerLike } from "../tasks/poller";
import { OmsTuiApp } from "../tui/app";
import { computeLayout } from "../tui/layout";
import { AgentPane } from "../tui/panes/agent-pane";
import { SettingsPane } from "../tui/panes/settings-pane";
import { SingularityPane } from "../tui/panes/singularity-pane";
import { SystemPane } from "../tui/panes/system-pane";
import { TasksDetailsPane } from "../tui/panes/tasks-details-pane";
import { TasksPane } from "../tui/panes/tasks-pane";
import { logger } from "../utils";

export async function runTuiMode(opts: {
	config: OmsConfig;
	targetProjectPath: string;
	omsSessionDir: string;
	singularitySockPath: string;
	tasksClient: TaskStoreClient;
	poller: TaskPollerLike;
	registry: AgentRegistry;
	scheduler: Scheduler;
	spawner: AgentSpawner;
	systemAgentId: string;
	sessionLogWriter: SessionLogWriter;
}): Promise<void> {
	let singularityIpcServer: net.Server | null = null;
	let loop: AgentLoop | null = null;
	let earlyWakeReceived = false;

	let shutdownFn: ((code: number, options?: { force?: boolean }) => Promise<void>) | null = null;
	const requestShutdown = (code: number, options?: { force?: boolean }) => {
		if (!shutdownFn) return;
		void shutdownFn(code, options);
	};

	const app = new OmsTuiApp(undefined, {
		onQuit: () => {
			requestShutdown(0);
		},
		layout: {
			tasksHeightRatio: opts.config.layout.tasksHeightRatio,
			agentsWidthRatio: opts.config.layout.agentsWidthRatio,
			systemHeightRatio: opts.config.layout.systemHeightRatio,
		},
	});

	// Reconcile agent pane selection on every redraw.
	// Auto mode: keep the current agent pinned; switch only when a new task agent appears.
	// Manual mode: keep the selected agent (including finished) while it still exists.
	const seenTaskAgentsInAuto = new Set<string>();
	app.setActiveAgentResolver((currentId, autoSwitch) => {
		const active = opts.registry
			.getActive()
			.filter(a => a.taskId != null)
			.sort((a, b) => b.lastActivity - a.lastActivity);
		if (autoSwitch) {
			let latestNew: (typeof active)[number] | null = null;
			for (const agent of active) {
				if (!seenTaskAgentsInAuto.has(agent.id)) {
					if (!latestNew || agent.spawnedAt > latestNew.spawnedAt) latestNew = agent;
				}
				seenTaskAgentsInAuto.add(agent.id);
			}

			if (latestNew) return latestNew.id;

			if (currentId && active.some(agent => agent.id === currentId)) return currentId;
		}
		// Manual mode: keep the selected agent (including terminal) while it still exists.
		if (!autoSwitch && currentId) {
			if (opts.registry.get(currentId)) return currentId;
		}

		if (active.length > 0) return active[0]!.id;
		// No active task agents — keep current if it still exists in registry.
		if (currentId && opts.registry.get(currentId)) return currentId;
		return null;
	});
	app.setHasActiveTasksChecker(() => {
		const issues = opts.poller.issuesSnapshot;
		return issues.some(issue => {
			const status = String(issue.status).toLowerCase();
			return status !== "closed";
		});
	});

	let lastWorkersCount: number | null = null;
	let lastReadyCount: number | null = null;
	let lastLoopPaused: boolean | null = null;
	const computeAndApplyCounts = () => {
		const readyTasks = opts.poller.readySnapshot.filter((i: any) => i.issue_type === "task").length;
		const activeWorkers = opts.registry
			.getActive()
			.filter(a => a.role === "worker" || a.role === "designer-worker").length;
		const loopPaused = loop?.isPaused() ?? false;
		if (lastWorkersCount === activeWorkers && lastReadyCount === readyTasks && lastLoopPaused === loopPaused) {
			return;
		}

		lastWorkersCount = activeWorkers;
		lastReadyCount = readyTasks;
		lastLoopPaused = loopPaused;
		app.setCounts({
			workersCount: activeWorkers,
			readyCount: readyTasks,
			loopPaused,
		});
	};

	let countsRefreshQueued = false;
	let pollerWakeQueued = false;
	const scheduleCountsRefresh = (wakeLoop = false) => {
		if (wakeLoop) pollerWakeQueued = true;
		if (countsRefreshQueued) return;
		countsRefreshQueued = true;
		queueMicrotask(() => {
			countsRefreshQueued = false;
			computeAndApplyCounts();
			if (pollerWakeQueued) {
				pollerWakeQueued = false;
				if (!loop?.isPaused()) loop?.wake();
			}
		});
	};
	const refreshCounts = () => {
		scheduleCountsRefresh(false);
	};

	try {
		singularityIpcServer = await startOmsSingularityIpcServer({
			sockPath: opts.singularitySockPath,
			onWake: async payload => {
				return await handleIpcMessage({
					payload,
					loop,
					registry: opts.registry,
					tasksClient: opts.tasksClient,
					systemAgentId: opts.systemAgentId,
					onRefresh: refreshCounts,
					onEarlyWake: () => {
						earlyWakeReceived = true;
					},
				});
			},
		});

		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC listening: ${opts.singularitySockPath}`,
			data: { sockPath: opts.singularitySockPath, sessionDir: opts.omsSessionDir },
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "warn",
			message: `Failed to start IPC server: ${message}`,
			data: err,
		});
		singularityIpcServer = null;
	}

	const isResizeIoctlEbadf = (err: unknown): boolean => {
		if (!(err instanceof Error)) return false;
		const msg = err.message ?? "";
		if (!/ioctl\(\d+\) failed, EBADF/i.test(msg)) return false;
		const stack = err.stack ?? "";
		return stack.includes("node:tty") || stack.includes("terminal-kit");
	};

	const writeOmsCrashLog = (context: string, error: unknown, extra?: unknown): string | null => {
		const systemEvents = opts.registry.get(opts.systemAgentId)?.events.slice(-80) ?? [];
		return opts.sessionLogWriter.writeCrashLog({
			context,
			error,
			state: {
				systemAgentId: opts.systemAgentId,
				activeAgents: opts.registry.listActiveSummaries(),
			},
			recentEvents: systemEvents,
			extra,
		});
	};

	process.on("uncaughtException", err => {
		if (isResizeIoctlEbadf(err)) {
			// Bun sometimes throws this during terminal resize. Swallow to keep OMS running.
			opts.registry.pushEvent(opts.systemAgentId, {
				type: "log",
				ts: Date.now(),
				level: "warn",
				message: `Ignored resize ioctl EBADF: ${(err as Error).message}`,
				data: err,
			});
			refreshCounts();
			return;
		}

		const crashPath = writeOmsCrashLog("oms-uncaught-exception", err, {
			hook: "process.on(uncaughtException)",
		});
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "error",
			message: `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
			data: { error: err, crashPath },
		});
		refreshCounts();
		logger.error("Unhandled error in TUI mode", { err });
		try {
			app.stop();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after app.stop();", { err });
		}
		void opts.sessionLogWriter.dispose().finally(() => process.exit(1));
	});

	process.on("unhandledRejection", reason => {
		const crashPath = writeOmsCrashLog("oms-unhandled-rejection", reason, {
			hook: "process.on(unhandledRejection)",
		});
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "error",
			message: `Unhandled rejection: ${String(reason)}`,
			data: { reason, crashPath },
		});
		refreshCounts();
		try {
			app.stop();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after app.stop();", { err });
		}
		void opts.sessionLogWriter.dispose().finally(() => process.exit(1));
	});

	const layout = computeLayout(process.stdout.columns, process.stdout.rows, {
		tasksHeightRatio: opts.config.layout.tasksHeightRatio,
		agentsWidthRatio: opts.config.layout.agentsWidthRatio,
		systemHeightRatio: opts.config.layout.systemHeightRatio,
	});
	const centerCols = Math.max(1, layout.singularity.width - 2);
	const centerRows = Math.max(1, layout.singularity.height - 2);

	const singularityPromptPath = path.resolve(getSrcDir(), "agents", "prompts", "singularity.md");
	const singularityAppendPrompt = fs.existsSync(singularityPromptPath) ? singularityPromptPath : undefined;
	if (!singularityAppendPrompt) {
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "warn",
			message: `Singularity prompt not found: ${singularityPromptPath}`,
			data: { singularityPromptPath },
		});
	}

	const { candidates: singularityExtensionCandidates } = resolveSingularityExtensionCandidates();
	const singularityExtensions: string[] = [];
	for (const extensionPath of singularityExtensionCandidates) {
		if (!fs.existsSync(extensionPath)) {
			opts.registry.pushEvent(opts.systemAgentId, {
				type: "log",
				ts: Date.now(),
				level: "warn",
				message: `Singularity extension not found: ${extensionPath}`,
				data: { extensionPath },
			});
			continue;
		}

		const probe = await probeExtensionLoad(extensionPath);
		if (!probe.ok) {
			opts.registry.pushEvent(opts.systemAgentId, {
				type: "log",
				ts: Date.now(),
				level: "warn",
				message: `Skipping singularity extension: ${extensionPath}`,
				data: { extensionPath, reason: probe.reason ?? "unknown" },
			});
			continue;
		}

		singularityExtensions.push(extensionPath);
	}

	opts.poller.on("error", err => {
		const message = err instanceof Error ? err.message : String(err);
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "error",
			message: `TaskPoller error: ${message}`,
			data: err,
		});
		refreshCounts();
	});

	const singularityPane = new SingularityPane({
		ompCli: opts.config.ompCli,
		cwd: opts.targetProjectPath,
		cols: centerCols,
		rows: centerRows,
		extensions: singularityExtensions,
		env: {
			OMS_SINGULARITY_SOCK: opts.singularitySockPath,
		},
		onDirty: () => app.requestRedraw(),
	});

	const tasksPane = new TasksPane({
		poller: opts.poller,
		registry: opts.registry,
		onDirty: () => app.requestRedraw(),
		onSelectAgent: (agentRegistryId: string) => {
			app.focusAgent(agentRegistryId);
		},
	});
	const tasksDetailsPane = new TasksDetailsPane({
		tasksClient: opts.tasksClient,
		tasksPane,
		registry: opts.registry,
		onDirty: () => app.requestRedraw(),
	});
	const agentPane = new AgentPane({ registry: opts.registry, onDirty: refreshCounts });
	const systemPane = new SystemPane({
		registry: opts.registry,
		agentId: opts.systemAgentId,
		onDirty: () => app.requestRedraw(),
		sessionLogWriter: opts.sessionLogWriter,
	});
	const settingsPane = new SettingsPane({
		config: opts.config,
		onClose: () => app.closeSettings(),
		onLayoutChanged: layoutConfig => {
			app.setLayoutOptions({
				tasksHeightRatio: layoutConfig.tasksHeightRatio,
				agentsWidthRatio: layoutConfig.agentsWidthRatio,
				systemHeightRatio: layoutConfig.systemHeightRatio,
			});
		},
		onPollIntervalChanged: intervalMs => {
			opts.poller.setIntervalMs(intervalMs);
			loop?.setPollIntervalMs(intervalMs);
		},
	});

	const stopSelected = () => {
		const selectedAgentId = tasksPane.getSelectedAgentId();
		if (selectedAgentId && tasksPane.isSelectedAgentOrphaned()) {
			void loop?.stopAgentById(selectedAgentId);
			refreshCounts();
			return;
		}
		const selectedId = tasksPane.getSelectedIssueId();
		if (!selectedId) return;
		const issues = opts.poller.issuesSnapshot;
		const selectedTask = issues.find(issue => issue.id === selectedId && issue.issue_type === "task");
		if (!selectedTask) return;
		void loop?.stopAgentsForTaskIdsAndPause(new Set([selectedTask.id]), {
			blockStoppedTasks: true,
			blockReason: "Blocked by user via Stop. Wait for Singularity + user guidance, then unblock to continue.",
		});
	};

	const stopAll = () => {
		void loop?.stopAllAgentsAndPause();
	};

	const selectAgentDelta = (delta: number, currentAgentId: string | null) => {
		if (!Number.isFinite(delta) || delta === 0) return;
		const direction = delta < 0 ? -1 : 1;
		const activeTaskAgentIds = opts.registry
			.getActive()
			.filter(agent => agent.taskId != null)
			.map(agent => agent.id);

		if (activeTaskAgentIds.length === 0) return;

		const currentIndex = currentAgentId ? activeTaskAgentIds.indexOf(currentAgentId) : -1;
		const startIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : activeTaskAgentIds.length;
		const nextIndex = Math.max(0, Math.min(activeTaskAgentIds.length - 1, startIndex + direction));
		const nextAgentId = activeTaskAgentIds[nextIndex];
		if (!nextAgentId) return;
		app.focusAgent(nextAgentId);
	};

	app.setKeybindActions({
		selectTasksDelta: delta => tasksPane.moveSelection(delta),
		selectAgentDelta,
		stopSelected,
		stopAll,
		toggleTasksClosed: () => tasksPane.toggleShowClosed(),
		toggleDoneAgents: () => tasksPane.toggleShowDoneAgents(),
		toggleMouseCapture: () => app.toggleMouseCapture(),
		toggleProfiling: () => app.toggleProfiling(),
		toggleOmsMessages: () => app.toggleOmsMessages(),
		toggleSettings: () => app.toggleSettings(),
	});

	app.setSettingsPane(settingsPane);

	try {
		app.start();
		app.setPanes({
			tasks: tasksPane,
			selected: tasksDetailsPane,
			singularity: {
				render: (term, region) => singularityPane.render(term, region),
				handleKey: (name, data) => {
					const forwarded = singularityPane.handleKey(name, data);
					if (forwarded) {
						if (loop?.isPaused()) loop.resume();
						loop?.wake();
						refreshCounts();
					}
					return forwarded;
				},
				handleMouse: (name, data, region) => {
					return singularityPane.handleMouse(name, data, region);
				},
				resize: (cols, rows) => singularityPane.resize(cols, rows),
				stop: () => singularityPane.stop(),
			},
			agents: agentPane,
			system: systemPane,
		});

		singularityPane.start(singularityAppendPrompt);

		// Agent loop
		loop = new AgentLoop({
			tasksClient: opts.tasksClient,
			registry: opts.registry,
			scheduler: opts.scheduler,
			spawner: opts.spawner,
			config: opts.config,
			onDirty: refreshCounts,
			logAgentId: opts.systemAgentId,
			crashLogWriter: opts.sessionLogWriter,
		});

		opts.poller.start();
		loop.start();
		if (earlyWakeReceived) {
			earlyWakeReceived = false;
			loop.wake();
		}

		opts.poller.on("ready-changed", () => {
			// If singularity (or a human) changed tasks, wake loop immediately.
			scheduleCountsRefresh(true);
		});
		opts.poller.on("issues-changed", () => {
			scheduleCountsRefresh(false);
		});
		refreshCounts();
	} catch (err) {
		// Restore terminal state before bubbling up.
		try {
			app.stop();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after app.stop();", { err });
		}
		try {
			opts.poller.stop();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after opts.poller.stop();", { err });
		}
		try {
			await loop?.stop();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after await loop?.stop();", { err });
		}
		try {
			singularityIpcServer?.close();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after singularityIpcServer?.close();", { err });
		}
		try {
			await opts.sessionLogWriter.dispose();
		} catch (err) {
			logger.debug("modes/tui.ts: best-effort failure after await opts.sessionLogWriter.dispose();", { err });
		}
		throw err;
	}

	const shutdownHandlers = setupShutdownHandlers({
		registry: opts.registry,
		app,
		poller: opts.poller,
		singularitySockPath: opts.singularitySockPath,
		onBeforeExit: () => opts.sessionLogWriter.dispose(),
		getLoop: () => loop,
		getIpcServer: () => singularityIpcServer,
	});
	shutdownFn = shutdownHandlers.shutdown;
}
