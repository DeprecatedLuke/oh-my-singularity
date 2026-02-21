#!/usr/bin/env bun
import * as path from "node:path";
import { AgentRegistry } from "./agents/registry";
import { AgentSpawner } from "./agents/spawner";
import { createEmptyAgentUsage } from "./agents/types";
import { type OmsLaunchOptions, resolveOmsCliBin, runOmsCli } from "./cli/commands";
import { DEFAULT_CONFIG, loadConfigFromEnvironment, mergeOmsConfig } from "./config";
import { LIMIT_POLLER_ACTIVITY_DEFAULT } from "./config/constants";
import { Scheduler } from "./loop/scheduler";
import { runPipeMode } from "./modes/pipe";
import { runTuiMode } from "./modes/tui";
import { ReplicaManager } from "./replica/manager";
import { SessionLogWriter } from "./session-log-writer";
import {
	computeOmsSingularitySockPath,
	ensureDirExists,
	ensureGlobalOmsConfigDir,
	loadOmsConfigOverride,
	resolveOmpPath,
} from "./setup/environment";
import type { TaskStoreClient } from "./tasks/client";
import { TaskPoller, type TaskPollerLike } from "./tasks/poller";
import { computeJsonTaskStoreDir, JsonTaskStore } from "./tasks/store";
import { logger } from "./utils";

const OMS_CLI_VERSION = "0.0.0";
const OMS_CLI_BIN = resolveOmsCliBin();

async function main(opts: OmsLaunchOptions): Promise<void> {
	if (process.env.OMS_RUNNING) {
		logger.error("ERROR: Cannot run OMS inside OMS.");
		process.exit(1);
	}
	process.env.OMS_RUNNING = "1";

	ensureDirExists(opts.targetProjectPath);

	const globalOms = ensureGlobalOmsConfigDir();
	const projectConfigPath = path.join(opts.targetProjectPath, ".oms", "config.json");
	let config = DEFAULT_CONFIG;
	const globalOverride = loadOmsConfigOverride(globalOms.configPath);
	if (globalOverride) config = mergeOmsConfig(config, globalOverride);
	const projectOverride = loadOmsConfigOverride(projectConfigPath);
	if (projectOverride) config = mergeOmsConfig(config, projectOverride);
	const envOverride = loadConfigFromEnvironment();
	if (Object.keys(envOverride).length > 0) config = mergeOmsConfig(config, envOverride);

	const { sessionDir: omsSessionDir, sockPath: singularitySockPath } = computeOmsSingularitySockPath(
		opts.targetProjectPath,
	);
	const sessionLogWriter = new SessionLogWriter({ sessionDir: omsSessionDir });
	const taskStoreDir = computeJsonTaskStoreDir(omsSessionDir);

	const tasksClient: TaskStoreClient = new JsonTaskStore({
		cwd: opts.targetProjectPath,
		sessionDir: omsSessionDir,
		actor: "oms-main",
	});
	await tasksClient.ready();
	process.env.OMS_TASK_STORE_DIR = taskStoreDir;

	const poller: TaskPollerLike = new TaskPoller({
		client: tasksClient,
		intervalMs: config.pollIntervalMs,
		includeIssueList: true,
		includeActivity: true,
		activityLimit: LIMIT_POLLER_ACTIVITY_DEFAULT,
	});

	const registry = new AgentRegistry({
		tasksClient,
		eventLimit: config.agentEventLimit,
		tasksAvailable: true,
	});
	const systemAgentId = "oms:system";
	registry.register({
		id: systemAgentId,
		agentType: "finisher",
		taskId: null,
		tasksAgentId: "",
		status: "running",
		usage: createEmptyAgentUsage(),
		events: [],
		spawnedAt: Date.now(),
		lastActivity: Date.now(),
	});

	const scheduler = new Scheduler({ tasksClient, registry, tasksAvailable: true });
	const replicaManager = new ReplicaManager({ projectRoot: tasksClient.workingDir });
	const spawner = new AgentSpawner({
		tasksClient,
		registry,
		config,
		replicaManager,
		ipcSockPath: singularitySockPath,
		tasksAvailable: true,
	});

	const ompPath = resolveOmpPath(config.ompCli);
	registry.pushEvent(systemAgentId, {
		type: "log",
		ts: Date.now(),
		level: "info",
		message: `OMS target: ${opts.targetProjectPath} | task store: json (${taskStoreDir}) | omp: ${ompPath}`,
		data: { targetProjectPath: opts.targetProjectPath, omp: ompPath, taskStore: "json", taskStoreDir },
	});

	if (opts.pipeMode) {
		await runPipeMode({
			config,
			targetProjectPath: opts.targetProjectPath,
			pipeRequestArg: opts.pipeRequestArg,
			omsSessionDir,
			singularitySockPath,
			tasksClient,
			poller,
			registry,
			scheduler,
			spawner,
			systemAgentId,
			sessionLogWriter,
		});
		process.exit(0);
	}

	await runTuiMode({
		config,
		targetProjectPath: opts.targetProjectPath,
		omsSessionDir,
		singularitySockPath,
		tasksClient,
		poller,
		registry,
		scheduler,
		spawner,
		systemAgentId,
		sessionLogWriter,
	});
}

void runOmsCli({
	argv: process.argv.slice(2),
	bin: OMS_CLI_BIN,
	version: OMS_CLI_VERSION,
	onLaunch: main,
}).catch(err => {
	logger.error("Unhandled error in main", { err });
	process.exit(1);
});
