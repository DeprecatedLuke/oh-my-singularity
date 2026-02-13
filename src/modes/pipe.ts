import fs from "node:fs";
import type net from "node:net";
import path from "node:path";
import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentSpawner } from "../agents/spawner";
import type { OmsConfig } from "../config";
import {
	DELAY_PIPE_EMPTY_WORK_GRACE_MS,
	DELAY_PIPE_FORCE_EXIT_GRACE_MS,
	INTERVAL_WAIT_SLEEP_MS,
	TIMEOUT_AGENT_STOP_GRACE_MS,
	TIMEOUT_AGENT_WAIT_MS,
	TIMEOUT_MIN_MS,
	TIMEOUT_QUIET_WINDOW_BASE_MS,
	TIMEOUT_QUIET_WINDOW_POLL_OFFSET_MS,
} from "../config/constants";
import { handleIpcMessage } from "../ipc/handlers";
import { startOmsSingularityIpcServer } from "../ipc/server";
import { AgentLoop } from "../loop/agent-loop";
import type { Scheduler } from "../loop/scheduler";
import type { SessionLogWriter } from "../session-log-writer";
import { buildEnv } from "../setup/environment";
import { getSrcDir, probeExtensionLoad, resolveSingularityExtensionCandidates } from "../setup/extensions";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskPollerLike } from "../tasks/poller";
import type { TaskIssue } from "../tasks/types";
import { asRecord, logger } from "../utils";

const PIPE_SINGULARITY_FALLBACK_TOOLS =
	"tasks,start_tasks,broadcast_to_workers,interrupt_agent,steer_agent,replace_agent,delete_task_issue,read,edit,grep,find,lsp,bash,python,calc,fetch,web_search";

function normalizePipeSingularityTools(tools: string | undefined): string | undefined {
	const base = typeof tools === "string" && tools.trim() ? tools : PIPE_SINGULARITY_FALLBACK_TOOLS;
	const normalized = base
		.split(",")
		.map(t => t.trim())
		.filter(t => t)
		.filter(t => t !== "ask")
		.filter(t => t !== "task")
		.join(",");
	return normalized || undefined;
}

async function readPipeRequestFromStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		if (typeof chunk === "string") {
			chunks.push(Buffer.from(chunk));
		} else {
			chunks.push(Buffer.from(chunk));
		}
	}
	return Buffer.concat(chunks).toString("utf8");
}

function normalizePipeIssueStatus(value: unknown): string {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase();
}

function summarizePipeText(text: string, maxChars = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxChars) return compact;
	return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function pickPipeWorkerSummary(issue: TaskIssue): string | null {
	const comments = Array.isArray(issue.comments) ? issue.comments : [];
	const workerComments = comments.filter(comment => {
		const author = typeof comment.author === "string" ? comment.author.toLowerCase() : "";
		return author.includes("worker");
	});
	if (workerComments.length === 0) return null;

	for (let i = workerComments.length - 1; i >= 0; i -= 1) {
		const comment = workerComments[i];
		if (!comment) continue;
		const text = typeof comment.text === "string" ? comment.text.trim() : "";
		if (!text) continue;
		if (/^completion\b/i.test(text)) {
			return summarizePipeText(text.replace(/^completion:\s*/i, ""));
		}
	}

	const latest = workerComments[workerComments.length - 1];
	if (!latest) return null;
	const latestText = typeof latest.text === "string" ? latest.text.trim() : "";
	if (!latestText) return null;
	return summarizePipeText(latestText);
}

type PipeCompletionResult = {
	trackedTaskIds: string[];
	createdTaskIds: string[];
};

async function waitForPipeCompletion(opts: {
	singularityRpc: OmsRpcClient;
	registry: AgentRegistry;
	systemAgentId: string;
	tasksClient: TaskStoreClient;
	baselineTaskIds: ReadonlySet<string>;
	pollIntervalMs: number;
}): Promise<PipeCompletionResult> {
	let singularityDone = false;
	let singularityError: unknown = null;
	void opts.singularityRpc
		.waitForAgentEnd(TIMEOUT_AGENT_WAIT_MS)
		.then(() => {
			singularityDone = true;
		})
		.catch(err => {
			singularityError = err;
		});

	const trackedTaskIds = new Set<string>();
	const createdTaskIds = new Set<string>();
	let sawRelevantWork = false;
	let quietSince = Date.now();
	const quietWindowMs = Math.max(
		TIMEOUT_QUIET_WINDOW_BASE_MS,
		opts.pollIntervalMs + TIMEOUT_QUIET_WINDOW_POLL_OFFSET_MS,
	);
	while (true) {
		if (singularityError) throw singularityError;
		for (const agent of opts.registry.getAll()) {
			if (agent.id === opts.systemAgentId) continue;
			if (typeof agent.taskId !== "string" || !agent.taskId.trim()) continue;
			trackedTaskIds.add(agent.taskId.trim());
		}

		const allTasks = await opts.tasksClient.list(["--all", "--type", "task"]);
		for (const issue of allTasks) {
			if (!opts.baselineTaskIds.has(issue.id)) {
				createdTaskIds.add(issue.id);
				trackedTaskIds.add(issue.id);
			}
		}

		const activeTrackedAgents = opts.registry
			.getActive()
			.filter(agent => agent.id !== opts.systemAgentId)
			.filter(agent => typeof agent.taskId === "string" && trackedTaskIds.has(agent.taskId));

		const inProgressTasks = await opts.tasksClient.list(["--status", "in_progress", "--type", "task"]);
		const inProgressTracked = inProgressTasks.filter(issue => trackedTaskIds.has(issue.id));
		const hasPendingWork = activeTrackedAgents.length > 0 || inProgressTracked.length > 0;

		if (trackedTaskIds.size > 0 || hasPendingWork) {
			sawRelevantWork = true;
		}

		if (!singularityDone || hasPendingWork) {
			quietSince = Date.now();
		} else {
			const elapsedQuietMs = Date.now() - quietSince;
			if (!sawRelevantWork && elapsedQuietMs >= DELAY_PIPE_EMPTY_WORK_GRACE_MS) {
				return {
					trackedTaskIds: [...trackedTaskIds].sort(),
					createdTaskIds: [...createdTaskIds].sort(),
				};
			}
			if (sawRelevantWork && elapsedQuietMs >= quietWindowMs) {
				return {
					trackedTaskIds: [...trackedTaskIds].sort(),
					createdTaskIds: [...createdTaskIds].sort(),
				};
			}
		}
		await new Promise<void>(resolve => setTimeout(resolve, INTERVAL_WAIT_SLEEP_MS));
	}
}

async function loadPipeIssueDetails(tasksClient: TaskStoreClient, taskIds: readonly string[]): Promise<TaskIssue[]> {
	const loaded = await Promise.all(
		taskIds.map(async taskId => {
			try {
				return await tasksClient.show(taskId);
			} catch {
				return null;
			}
		}),
	);
	return loaded.filter((issue): issue is TaskIssue => issue !== null);
}

function buildPipeResultSummary(opts: {
	request: string;
	singularityResponse: string;
	createdIssues: readonly TaskIssue[];
	trackedIssues: readonly TaskIssue[];
	failedAgents: readonly string[];
}): string {
	const lines: string[] = [];
	const sortIssues = (issues: readonly TaskIssue[]): TaskIssue[] =>
		[...issues].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));

	lines.push("OMS pipe execution summary");
	lines.push("");
	lines.push(`Request: ${summarizePipeText(opts.request, 500)}`);

	if (opts.singularityResponse.trim()) {
		lines.push("");
		lines.push("Singularity initial response:");
		lines.push(opts.singularityResponse.trim());
	}

	const createdIssues = sortIssues(opts.createdIssues);
	const trackedIssues = sortIssues(opts.trackedIssues);

	lines.push("");
	lines.push(`Tasks created: ${createdIssues.length}`);
	if (createdIssues.length === 0) {
		lines.push("- none");
	} else {
		for (const issue of createdIssues) {
			const status = typeof issue.status === "string" ? issue.status : String(issue.status ?? "unknown");
			lines.push(`- ${issue.id} [${status}] ${issue.title}`);
		}
	}

	lines.push("");
	lines.push(`Tracked task outcomes: ${trackedIssues.length}`);
	if (trackedIssues.length === 0) {
		lines.push("- no spawned task work detected");
	} else {
		for (const issue of trackedIssues) {
			const status = typeof issue.status === "string" ? issue.status : String(issue.status ?? "unknown");
			lines.push(`- ${issue.id} [${status}] ${issue.title}`);
			const workerSummary = pickPipeWorkerSummary(issue);
			lines.push(`  worker: ${workerSummary ?? "no worker completion comment recorded"}`);
		}
	}

	const unfinishedTasks = trackedIssues.filter(issue => {
		const status = normalizePipeIssueStatus(issue.status);
		return status !== "closed" && status !== "done";
	});

	lines.push("");
	lines.push("Failures / unfinished:");
	if (unfinishedTasks.length === 0 && opts.failedAgents.length === 0) {
		lines.push("- none");
	} else {
		for (const issue of unfinishedTasks) {
			const status = typeof issue.status === "string" ? issue.status : String(issue.status ?? "unknown");
			lines.push(`- task ${issue.id} ended with status ${status}`);
		}
		for (const failure of opts.failedAgents) {
			lines.push(`- ${failure}`);
		}
	}

	return lines.join("\n");
}

export async function runPipeMode(opts: {
	config: OmsConfig;
	targetProjectPath: string;
	pipeRequestArg: string;
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
	const stdinRequest = await readPipeRequestFromStdin();
	const userRequest = stdinRequest.trim() ? stdinRequest : opts.pipeRequestArg;
	if (!userRequest.trim()) {
		throw new Error("Pipe mode requires request text via stdin or positional args after <target-project-path>.");
	}

	let singularityIpcServer: net.Server | null = null;
	let loop: AgentLoop | null = null;
	let earlyWakeReceived = false;
	let singularityRpc: OmsRpcClient | null = null;

	const trackedRpcClients = (): OmsRpcClient[] => {
		const out: OmsRpcClient[] = [];
		const seen = new Set<OmsRpcClient>();

		for (const agent of opts.registry.getAll()) {
			const rpc = agent.rpc;
			if (!(rpc instanceof OmsRpcClient)) continue;
			if (seen.has(rpc)) continue;
			seen.add(rpc);
			out.push(rpc);
		}

		if (singularityRpc && !seen.has(singularityRpc)) {
			seen.add(singularityRpc);
			out.push(singularityRpc);
		}

		return out;
	};

	const forceKillTrackedAgents = () => {
		for (const rpc of trackedRpcClients()) {
			try {
				rpc.forceKill();
			} catch (err) {
				logger.debug("modes/pipe.ts: best-effort failure after rpc.forceKill();", { err });
			}
		}
	};

	const stopTrackedAgentsGracefully = async (timeoutMs = TIMEOUT_AGENT_STOP_GRACE_MS): Promise<void> => {
		await Promise.all(
			trackedRpcClients().map(async rpc => {
				try {
					await rpc.stop({ timeoutMs });
				} catch (err) {
					logger.debug("modes/pipe.ts: best-effort failure after await rpc.stop({ timeoutMs });", { err });
				}
			}),
		);
	};

	const cleanup = async (): Promise<void> => {
		try {
			singularityIpcServer?.close();
		} catch (err) {
			logger.debug("modes/pipe.ts: best-effort failure after singularityIpcServer?.close();", { err });
		}
		try {
			if (fs.existsSync(opts.singularitySockPath)) fs.unlinkSync(opts.singularitySockPath);
		} catch (err) {
			logger.debug(
				"modes/pipe.ts: best-effort failure after if (fs.existsSync(opts.singularitySockPath)) fs.unlinkSync(opts.singularitySockPath);",
				{ err },
			);
		}
		try {
			opts.poller.stop();
		} catch (err) {
			logger.debug("modes/pipe.ts: best-effort failure after opts.poller.stop();", { err });
		}
		try {
			await loop?.stop();
		} catch (err) {
			logger.debug("modes/pipe.ts: best-effort failure after await loop?.stop();", { err });
		}
		await stopTrackedAgentsGracefully(TIMEOUT_AGENT_STOP_GRACE_MS);
	};

	const writePipeCrashLog = (context: string, error: unknown, extra?: unknown): string | null => {
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
		const crashPath = writePipeCrashLog("oms-pipe-uncaught-exception", err, {
			hook: "process.on(uncaughtException)",
		});
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "error",
			message: `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`,
			data: { error: err, crashPath },
		});
		forceKillTrackedAgents();
		process.exit(1);
	});

	process.on("unhandledRejection", reason => {
		const crashPath = writePipeCrashLog("oms-pipe-unhandled-rejection", reason, {
			hook: "process.on(unhandledRejection)",
		});
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "error",
			message: `Unhandled rejection: ${String(reason)}`,
			data: { reason, crashPath },
		});
		forceKillTrackedAgents();
		process.exit(1);
	});

	try {
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

		const singularityPromptPath = path.resolve(getSrcDir(), "agents", "prompts", "singularity-pipe.md");
		const singularityAppendPrompt = fs.existsSync(singularityPromptPath) ? singularityPromptPath : undefined;
		if (!singularityAppendPrompt) {
			opts.registry.pushEvent(opts.systemAgentId, {
				type: "log",
				ts: Date.now(),
				level: "warn",
				message: `Singularity pipe prompt not found: ${singularityPromptPath}`,
				data: { singularityPromptPath },
			});
		}

		const { candidates: singularityExtensionCandidates, singularityGuardExtensionPath } =
			resolveSingularityExtensionCandidates();
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

		if (!singularityExtensions.includes(singularityGuardExtensionPath)) {
			throw new Error(
				`Pipe mode requires singularity tool guard extension to disable ask: ${singularityGuardExtensionPath}`,
			);
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
		});

		loop = new AgentLoop({
			tasksClient: opts.tasksClient,
			registry: opts.registry,
			scheduler: opts.scheduler,
			spawner: opts.spawner,
			config: opts.config,
			onDirty: () => {
				// no-op in pipe mode
			},
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
			if (!loop?.isPaused()) loop?.wake();
		});

		const baselineTasks = await opts.tasksClient.list(["--all", "--type", "task"]);
		const baselineTaskIds = new Set(baselineTasks.map(issue => issue.id));
		const singularityTools = normalizePipeSingularityTools(undefined);
		const singularityArgs: string[] = [
			"--no-pty",
			...(singularityTools ? ["--tools", singularityTools] : []),
			...singularityExtensions.flatMap(ext => ["--extension", ext]),
			...(singularityAppendPrompt ? ["--append-system-prompt", singularityAppendPrompt] : []),
		];

		const runSingularityAttempt = async (
			requestText: string,
		): Promise<{ rpc: OmsRpcClient; completion: PipeCompletionResult; assistantText: string }> => {
			const attemptRpc = new OmsRpcClient({
				ompCli: opts.config.ompCli,
				cwd: opts.targetProjectPath,
				env: buildEnv({
					TASKS_ACTOR: "oms-singularity",
					OMS_ROLE: "singularity",
					OMS_PIPE_MODE: "1",
					OMS_SINGULARITY_SOCK: opts.singularitySockPath,
				}),
				args: singularityArgs,
			});
			singularityRpc = attemptRpc;

			let currentAssistantText = "";
			const assistantTextParts: string[] = [];
			const unsubscribeAttemptEvents = attemptRpc.onEvent(event => {
				const rec = asRecord(event);
				if (!rec || rec.type !== "message_update") return;
				const inner = asRecord(rec.assistantMessageEvent);
				if (!inner) return;
				const innerType = typeof inner.type === "string" ? inner.type : "";
				if (innerType === "text_start") {
					currentAssistantText = "";
					return;
				}
				if (innerType === "text_delta") {
					const delta = typeof inner.delta === "string" ? inner.delta : "";
					if (delta) currentAssistantText += delta;
					return;
				}
				if (innerType === "text_end") {
					const content = typeof inner.content === "string" ? inner.content : "";
					if (!currentAssistantText && content) {
						currentAssistantText = content;
					}
					if (currentAssistantText) {
						assistantTextParts.push(currentAssistantText);
						currentAssistantText = "";
					}
				}
			});

			try {
				attemptRpc.start();
				await attemptRpc.prompt(requestText);
				const completion = await waitForPipeCompletion({
					singularityRpc: attemptRpc,
					registry: opts.registry,
					systemAgentId: opts.systemAgentId,
					tasksClient: opts.tasksClient,
					baselineTaskIds,
					pollIntervalMs: opts.config.pollIntervalMs,
				});
				let assistantText = "";
				try {
					assistantText = (await attemptRpc.getLastAssistantText()) ?? "";
				} catch {
					assistantText = "";
				}
				const streamedAssistantText = [...assistantTextParts, currentAssistantText].join("").trim();
				if (!assistantText.trim() && streamedAssistantText) {
					assistantText = streamedAssistantText;
				}
				return { rpc: attemptRpc, completion, assistantText };
			} finally {
				unsubscribeAttemptEvents();
			}
		};

		let { rpc: attemptRpc, completion, assistantText } = await runSingularityAttempt(userRequest);

		if (!assistantText.trim() && completion.trackedTaskIds.length === 0 && completion.createdTaskIds.length === 0) {
			opts.registry.pushEvent(opts.systemAgentId, {
				type: "log",
				ts: Date.now(),
				level: "warn",
				message:
					"Pipe singularity produced empty output with no tracked work; retrying once with explicit response requirement",
				data: { request: summarizePipeText(userRequest, 200) },
			});
			try {
				await attemptRpc.stop({ timeoutMs: TIMEOUT_MIN_MS });
			} catch (err) {
				logger.debug(
					"modes/pipe.ts: best-effort failure after await attemptRpc.stop({ timeoutMs: TIMEOUT_MIN_MS });",
					{ err },
				);
			}
			singularityRpc = null;

			const retryRequest = [
				"Your previous response was empty.",
				"You must return a concise text response.",
				"If implementation work is requested, create/update tasks issues and call start_tasks before responding.",
				"",
				"Original request:",
				userRequest,
			].join("\n");
			({ rpc: attemptRpc, completion, assistantText } = await runSingularityAttempt(retryRequest));
		}

		const trackedIssues = await loadPipeIssueDetails(opts.tasksClient, completion.trackedTaskIds);
		const issueById = new Map(trackedIssues.map(issue => [issue.id, issue] as const));
		const createdIssues = completion.createdTaskIds
			.map(taskId => issueById.get(taskId))
			.filter((issue): issue is TaskIssue => issue !== undefined);

		const trackedTaskIds = new Set(completion.trackedTaskIds);
		const failedAgents = opts.registry
			.getAll()
			.filter(agent => agent.id !== opts.systemAgentId)
			.filter(agent => typeof agent.taskId === "string" && trackedTaskIds.has(agent.taskId))
			.filter(agent => {
				const status = typeof agent.status === "string" ? agent.status.trim().toLowerCase() : "";
				return status === "failed" || status === "dead" || status === "aborted";
			})
			.map(agent => `agent ${agent.id} (${agent.role}) on ${agent.taskId} ended with status ${agent.status}`);

		const summary = buildPipeResultSummary({
			request: userRequest,
			singularityResponse: assistantText,
			createdIssues,
			trackedIssues,
			failedAgents,
		});
		process.stdout.write(summary.endsWith("\n") ? summary : `${summary}\n`);
	} finally {
		await Promise.race([
			cleanup(),
			new Promise<void>(resolve => setTimeout(resolve, DELAY_PIPE_FORCE_EXIT_GRACE_MS)),
		]);
		forceKillTrackedAgents();
	}
}
