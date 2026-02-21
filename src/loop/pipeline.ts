import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { getAgentLifecycleConfig, LIMIT_AGENT_MAX_RETRIES, type LifecycleAction } from "../config/constants";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { logger } from "../utils";
import type { Scheduler } from "./scheduler";

type LogLevel = "debug" | "info" | "warn" | "error";

export interface PipelineServices {
	tasksClient: TaskStoreClient;
	registry: AgentRegistry;
	scheduler: Scheduler;
	spawner: AgentSpawner;
	getMaxWorkers: () => number;
	getActiveWorkerAgents: () => AgentInfo[];
	loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
	onDirty?: () => void;
	wake: () => void;
	attachRpcHandlers: (agent: AgentInfo) => void;
	finishAgent: (
		agent: AgentInfo,
		status: "done" | "stopped" | "dead",
		opts?: { crashReason?: string; crashEvent?: unknown },
	) => Promise<void>;
	logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
	logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
	hasPendingInterruptKickoff: (taskId: string) => boolean;
	takePendingInterruptKickoff: (taskId: string) => string | null;
	hasFinisherTakeover: (taskId: string) => boolean;
	spawnFinisherAfterStoppingSteering: (
		taskId: string,
		workerOutput: string,
		resumeSessionId?: string,
	) => Promise<AgentInfo>;
	isRunning: () => boolean;
	isPaused: () => boolean;
}
export type LifecycleRecord = {
	taskId: string;
	agentType: string;
	action: LifecycleAction;
	target: string | null;
	message: string | null;
	reason: string | null;
	agentId: string | null;
	ts: number;
};
type ResumeDecision = {
	action: "advance" | "close" | "block";
	target?: string;
	message: string | null;
	reason: string | null;
};

export type IssuerResult = {
	start: boolean;
	skip?: boolean;
	target?: string;
	message: string | null;
	reason: string | null;
	raw: string | null;
};

export type SpeedyResult = {
	done: boolean;
	escalate: boolean;
	closed: boolean;
	message: string | null;
	reason: string | null;
	raw: string | null;
};

type AttemptResult =
	| { ok: true; record: LifecycleRecord }
	| {
			ok: false;
			reason: string;
			sessionId: string | null;
			missingAdvanceTool: boolean;
			agentStatus?: "stopped" | "dead";
	  };

type AttemptFailure = {
	reason: string;
	sessionId: string | null;
	missingAdvanceTool: boolean;
};

type RetryStep = {
	mode: "spawn" | "resume";
	resumeSessionId: string | null;
	steerMessage: string | null;
};

type NextRetryStep = RetryStep & { checkTaskStatus: boolean };

type AgentRetryConfig<TResult> = {
	agentName: string;
	agentLabel: string;
	task: TaskIssue;
	spawnFn: (
		mode: "spawn" | "resume",
		resumeSessionId: string | null,
		steerMessage: string | null,
	) => Promise<AgentInfo>;
	toResult: (record: LifecycleRecord) => TResult;
	makeFailureResult: (reason: string) => TResult;
	makeAbortResult: (abortReason: string) => TResult;
	initialStep: RetryStep;
	getNextStep: (context: {
		attemptIndex: number;
		lastFailure: AttemptFailure;
		allFailures: AttemptFailure[];
	}) => NextRetryStep | null;
};

const WORKER_AGENT_RULES: ReadonlyArray<{ labelPattern: RegExp; agent: string }> = [
	{ labelPattern: /\bdesign\b|\bui\b|\bux\b|\bfigma\b|\bvisual\b|\bbrand\b/, agent: "designer" },
];
const DEFAULT_WORKER_AGENT = "worker";

function resolveWorkerAgent(issue: TaskIssue, targetOverride?: string): string {
	if (targetOverride) return targetOverride;
	const labels = Array.isArray(issue.labels) ? issue.labels : [];
	const haystack = labels.join(" ").toLowerCase();
	for (const rule of WORKER_AGENT_RULES) {
		if (rule.labelPattern.test(haystack)) return rule.agent;
	}
	return DEFAULT_WORKER_AGENT;
}

function normalizeSessionId(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

function lifecycleRecordToRaw(record: LifecycleRecord): string | null {
	try {
		return JSON.stringify({
			action: record.action,
			target: record.target,
			message: record.message,
			reason: record.reason,
			agentId: record.agentId,
			ts: record.ts,
		});
	} catch {
		return null;
	}
}

function toIssuerResult(record: LifecycleRecord): IssuerResult {
	const raw = lifecycleRecordToRaw(record);
	if (record.action === "close") {
		return { start: false, skip: true, message: record.message, reason: record.reason, raw };
	}
	if (record.action === "block") {
		return { start: false, message: record.message, reason: record.reason, raw };
	}
	return { start: true, target: record.target ?? undefined, message: record.message, reason: record.reason, raw };
}

function toSpeedyResult(record: LifecycleRecord): SpeedyResult {
	const raw = lifecycleRecordToRaw(record);
	if (record.action === "close") {
		return { done: true, escalate: false, closed: true, message: record.reason, reason: null, raw };
	}
	if (record.action === "advance" && record.target === "issuer") {
		return { done: false, escalate: true, closed: false, message: record.message, reason: record.reason, raw };
	}
	if (record.action === "block") {
		return { done: false, escalate: false, closed: false, message: record.message, reason: record.reason, raw };
	}
	// action === "advance" with target === "finisher" (or other)
	return { done: true, escalate: false, closed: false, message: record.message, reason: record.reason, raw };
}

export class PipelineManager {
	private readonly tasksClient: TaskStoreClient;
	private readonly registry: AgentRegistry;
	private readonly scheduler: Scheduler;
	private readonly spawner: AgentSpawner;
	private readonly getMaxWorkers: () => number;
	private readonly getActiveWorkerAgents: () => AgentInfo[];
	private readonly loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
	private readonly onDirty?: () => void;
	private readonly wake: () => void;
	private readonly attachRpcHandlers: (agent: AgentInfo) => void;
	private readonly finishAgent: (
		agent: AgentInfo,
		status: "done" | "stopped" | "dead",
		opts?: { crashReason?: string; crashEvent?: unknown },
	) => Promise<void>;
	private readonly logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
	private readonly logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
	private readonly hasFinisherTakeover: (taskId: string) => boolean;
	private readonly spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<AgentInfo>;
	private readonly isRunning: () => boolean;
	private readonly isPaused: () => boolean;
	private readonly hasPendingInterruptKickoff: (taskId: string) => boolean;
	private readonly takePendingInterruptKickoff: (taskId: string) => string | null;

	private readonly pipelineInFlight = new Map<string, number>();
	private readonly lifecycleByTask = new Map<string, LifecycleRecord>();
	readonly pendingWorkerReplacements = new Set<string>();

	constructor(services: PipelineServices) {
		this.tasksClient = services.tasksClient;
		this.registry = services.registry;
		this.scheduler = services.scheduler;
		this.spawner = services.spawner;
		this.getMaxWorkers = services.getMaxWorkers;
		this.getActiveWorkerAgents = services.getActiveWorkerAgents;
		this.loopLog = services.loopLog;
		this.onDirty = services.onDirty;
		this.wake = services.wake;
		this.attachRpcHandlers = services.attachRpcHandlers;
		this.finishAgent = services.finishAgent;
		this.logAgentStart = services.logAgentStart;
		this.logAgentFinished = services.logAgentFinished;
		this.hasPendingInterruptKickoff = services.hasPendingInterruptKickoff;
		this.takePendingInterruptKickoff = services.takePendingInterruptKickoff;
		this.hasFinisherTakeover = services.hasFinisherTakeover;
		this.spawnFinisherAfterStoppingSteering = services.spawnFinisherAfterStoppingSteering;
		this.isRunning = services.isRunning;
		this.isPaused = services.isPaused;
	}

	advanceLifecycle(opts: {
		agentType?: string;
		taskId?: string;
		action?: string;
		target?: string;
		message?: string;
		reason?: string;
		agentId?: string;
	}): Record<string, unknown> {
		const taskId = typeof opts.taskId === "string" ? opts.taskId.trim() : "";
		if (!taskId) {
			return { ok: false, summary: "advance_lifecycle rejected: taskId is required" };
		}

		const agentType = typeof opts.agentType === "string" ? opts.agentType.trim().toLowerCase() : "";
		if (!agentType) {
			return { ok: false, summary: "advance_lifecycle rejected: agentType is required" };
		}

		const rawAction = typeof opts.action === "string" ? opts.action.trim().toLowerCase() : "";
		const validActions: LifecycleAction[] = ["close", "block", "advance"];
		const action = validActions.includes(rawAction as LifecycleAction) ? (rawAction as LifecycleAction) : null;
		if (!action) {
			return {
				ok: false,
				summary: `advance_lifecycle rejected: unsupported action '${rawAction || "(empty)"}'`,
			};
		}

		const lifecycleCfg = getAgentLifecycleConfig(agentType);
		if (lifecycleCfg && !lifecycleCfg.allowedActions.has(action)) {
			return {
				ok: false,
				summary: `advance_lifecycle rejected: action '${action}' not allowed for agent type '${agentType}'`,
			};
		}

		const target = typeof opts.target === "string" ? opts.target.trim().toLowerCase() : "";
		if (action === "advance") {
			if (!target) {
				return { ok: false, summary: "advance_lifecycle rejected: target is required when action is 'advance'" };
			}
			if (lifecycleCfg && !lifecycleCfg.allowedAdvanceTargets.includes(target)) {
				return {
					ok: false,
					summary: `advance_lifecycle rejected: target '${target}' not valid for agent type '${agentType}'. Valid: ${lifecycleCfg.allowedAdvanceTargets.join(", ")}`,
				};
			}
		}

		const message = typeof opts.message === "string" ? opts.message.trim() : "";
		const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
		const agentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
		const current = this.lifecycleByTask.get(taskId);
		const next: LifecycleRecord = {
			taskId,
			agentType,
			action,
			target: target || null,
			message: message || null,
			reason: reason || null,
			agentId: agentId || null,
			ts: Date.now(),
		};
		this.lifecycleByTask.set(taskId, next);

		const actionSummary = action === "advance" ? `${action}(target=${target})` : action;
		this.loopLog(
			current
				? `Lifecycle decision updated for ${taskId} (${agentType}): ${current.action} -> ${actionSummary}`
				: `Lifecycle decision recorded for ${taskId} (${agentType}): ${actionSummary}`,
			current ? "warn" : "info",
			{
				taskId,
				agentType,
				action,
				target: next.target,
				reason: next.reason,
				message: next.message,
				agentId: next.agentId,
			},
		);

		return {
			ok: true,
			summary: `advance_lifecycle recorded for ${taskId}: ${actionSummary}`,
			taskId,
			action,
			target: next.target,
			message: next.message,
			reason: next.reason,
			agentId: next.agentId,
		};
	}

	addPipelineInFlight(taskId: string): void {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return;
		this.pipelineInFlight.set(normalizedTaskId, (this.pipelineInFlight.get(normalizedTaskId) ?? 0) + 1);
	}

	removePipelineInFlight(taskId: string): void {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return;
		const count = this.pipelineInFlight.get(normalizedTaskId) ?? 0;
		if (count <= 1) {
			this.pipelineInFlight.delete(normalizedTaskId);
		} else {
			this.pipelineInFlight.set(normalizedTaskId, count - 1);
		}
	}

	isPipelineInFlight(taskId: string): boolean {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		return (this.pipelineInFlight.get(normalizedTaskId) ?? 0) > 0;
	}

	markWorkerReplacementPending(taskId: string): void {
		const id = taskId.trim();
		if (id) this.pendingWorkerReplacements.add(id);
	}

	clearWorkerReplacementPending(taskId: string): void {
		const id = taskId.trim();
		if (id) this.pendingWorkerReplacements.delete(id);
	}

	availableWorkerSlots(): number {
		const activeWorkers = this.getActiveWorkerAgents().length;
		const reserved = this.pipelineInFlight.size;
		return Math.max(0, this.getMaxWorkers() - activeWorkers - reserved);
	}

	async runIssuerForTask(task: TaskIssue, opts?: { kickoffMessage?: string }): Promise<IssuerResult> {
		const kickoffMessage = opts?.kickoffMessage?.trim() || "";
		const buildRecoveryNudge = (): string => {
			const lines = [
				"[SYSTEM RECOVERY]",
				"Your previous issuer run ended without calling `advance_lifecycle`, so OMS could not continue.",
				'Resume this task and call `advance_lifecycle` exactly once with action="advance" (target="worker" or "designer"), "close", or "block".',
				"Then stop.",
			];
			if (kickoffMessage) {
				lines.push("", "Original kickoff context:", kickoffMessage);
			}
			return lines.join("\n");
		};

		return this.#runAgentWithRetry<IssuerResult>({
			agentName: "issuer",
			agentLabel: "Issuer",
			task,
			spawnFn: (mode, resumeSessionId, steerMessage) => {
				if (mode === "resume" && resumeSessionId) {
					return this.spawner.resumeAgent(task.id, resumeSessionId, steerMessage?.trim() || undefined);
				}
				return this.spawner.spawnIssuer(task.id, steerMessage?.trim() || undefined);
			},
			toResult: toIssuerResult,
			makeFailureResult: reason => ({ start: false, message: null, reason, raw: null }),
			makeAbortResult: reason => ({ start: false, message: null, reason, raw: null }),
			initialStep: { mode: "spawn", resumeSessionId: null, steerMessage: kickoffMessage || null },
			getNextStep: ({ attemptIndex, lastFailure }) => {
				if (attemptIndex >= LIMIT_AGENT_MAX_RETRIES - 1) return null;
				return {
					mode: lastFailure.sessionId ? "resume" : "spawn",
					resumeSessionId: lastFailure.sessionId,
					steerMessage: buildRecoveryNudge(),
					checkTaskStatus: true,
				};
			},
		});
	}

	async runSpeedyForTask(task: TaskIssue, opts?: { kickoffMessage?: string }): Promise<SpeedyResult> {
		const kickoffMessage = opts?.kickoffMessage?.trim() || "";
		const missingAdvanceNudge = [
			"[SYSTEM RECOVERY]",
			"Your previous speedy run ended without calling `advance_lifecycle`, so OMS could not continue.",
			'Call `advance_lifecycle` exactly once: action="close" (if done), action="advance" with target="finisher" (needs review), or target="issuer" (too complex).',
			"Then stop.",
			...(kickoffMessage ? ["", "Original kickoff context:", kickoffMessage] : []),
		].join("\n");
		const resumeExecutionNudge = [
			"[SYSTEM RESUME]",
			"Your previous speedy process exited unexpectedly before lifecycle completion.",
			'Call `advance_lifecycle` exactly once: action="close" (if done), action="advance" with target="finisher" (needs review), or target="issuer" (too complex).',
			"Then stop.",
			...(kickoffMessage ? ["", "Original kickoff context:", kickoffMessage] : []),
		].join("\n");

		return this.#runAgentWithRetry<SpeedyResult>({
			agentName: "speedy",
			agentLabel: "Fast-worker",
			task,
			spawnFn: (mode, resumeSessionId, steerMessage) =>
				this.spawner.spawnAgent("speedy", task.id, {
					claim: false,
					resumeSessionId: mode === "resume" ? (resumeSessionId ?? undefined) : undefined,
					kickoffMessage: steerMessage?.trim() || undefined,
				}),
			toResult: toSpeedyResult,
			makeFailureResult: reason => ({
				done: false,
				escalate: false,
				closed: false,
				message: null,
				reason,
				raw: null,
			}),
			makeAbortResult: reason => ({
				done: false,
				escalate: false,
				closed: false,
				message: null,
				reason,
				raw: null,
			}),
			initialStep: { mode: "spawn", resumeSessionId: null, steerMessage: kickoffMessage || null },
			getNextStep: ({ attemptIndex, lastFailure, allFailures }) => {
				if (attemptIndex === 0) {
					if (lastFailure.sessionId) {
						const nudge = lastFailure.missingAdvanceTool ? missingAdvanceNudge : resumeExecutionNudge;
						return {
							mode: "resume",
							resumeSessionId: lastFailure.sessionId,
							steerMessage: nudge,
							checkTaskStatus: true,
						};
					}
					const nudge = lastFailure.missingAdvanceTool ? missingAdvanceNudge : kickoffMessage || null;
					return { mode: "spawn", resumeSessionId: null, steerMessage: nudge, checkTaskStatus: true };
				}
				if (attemptIndex === 1 && allFailures[0]?.sessionId) {
					const anyMissing = allFailures.some(f => f.missingAdvanceTool);
					const nudge = anyMissing ? missingAdvanceNudge : kickoffMessage || null;
					return { mode: "spawn", resumeSessionId: null, steerMessage: nudge, checkTaskStatus: false };
				}
				return null;
			},
		});
	}

	async spawnTaskWorker(
		issue: TaskIssue,
		opts?: { claim?: boolean; kickoffMessage?: string | null; target?: string },
	): Promise<AgentInfo> {
		const targetAgent = resolveWorkerAgent(issue, opts?.target);
		const kickoffMessage = opts?.kickoffMessage?.trim() || undefined;
		const worker = await this.spawner.spawnAgent(targetAgent, issue.id, {
			claim: opts?.claim,
			kickoffMessage,
		});

		this.attachRpcHandlers(worker);
		return worker;
	}

	kickoffResumePipeline(task: TaskIssue): void {
		const taskId = task.id.trim();
		if (!taskId) return;
		if ((this.pipelineInFlight.get(taskId) ?? 0) > 0) {
			this.loopLog(`Resume pipeline already in-flight for ${taskId}, skipping duplicate`, "debug", {
				taskId,
			});
			return;
		}
		this.pipelineInFlight.set(taskId, (this.pipelineInFlight.get(taskId) ?? 0) + 1);
		void this.runResumePipeline(task)
			.catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				this.loopLog(`Resume pipeline failed for ${taskId}: ${message}`, "warn", {
					taskId,
					error: message,
				});
			})
			.finally(() => {
				const c = this.pipelineInFlight.get(taskId) ?? 0;
				if (c <= 1) this.pipelineInFlight.delete(taskId);
				else this.pipelineInFlight.set(taskId, c - 1);
				this.onDirty?.();
				this.wake();
			});
	}

	kickoffNewTaskPipeline(task: TaskIssue): void {
		this.pipelineInFlight.set(task.id, (this.pipelineInFlight.get(task.id) ?? 0) + 1);
		void this.runNewTaskPipeline(task)
			.catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				this.loopLog(`Pipeline failed for ${task.id}: ${message}`, "warn", {
					taskId: task.id,
					error: message,
				});
			})
			.finally(() => {
				const c = this.pipelineInFlight.get(task.id) ?? 0;
				if (c <= 1) this.pipelineInFlight.delete(task.id);
				else this.pipelineInFlight.set(task.id, c - 1);
				this.onDirty?.();
				this.wake();
			});
	}

	takeLifecycleRecord(taskId: string): LifecycleRecord | null {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return null;
		const record = this.lifecycleByTask.get(normalizedTaskId) ?? null;
		if (record) this.lifecycleByTask.delete(normalizedTaskId);
		return record;
	}

	hasLifecycleRecord(taskId: string): boolean {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		return this.lifecycleByTask.has(normalizedTaskId);
	}

	async #runAgentWithRetry<TResult>(config: AgentRetryConfig<TResult>): Promise<TResult> {
		const { task, agentName, agentLabel, toResult, makeFailureResult, makeAbortResult } = config;
		const allFailures: AttemptFailure[] = [];
		let currentStep: RetryStep | null = config.initialStep;

		for (let attempt = 0; currentStep; attempt++) {
			const result = await this.#runAgentAttempt(task, agentName, agentLabel, config.spawnFn, currentStep);
			if (result.ok) return toResult(result.record);

			// Stopped agents were killed externally (e.g., replace_agent) — never retry.
			// Only dead or incomplete agents should be retried.
			if (!result.ok && result.agentStatus === "stopped") {
				return makeAbortResult(`${agentName} stopped externally — pipeline replaced by singularity`);
			}

			const failure: AttemptFailure = {
				reason: result.reason,
				sessionId: result.sessionId,
				missingAdvanceTool: result.missingAdvanceTool,
			};
			allFailures.push(failure);

			const nextStep = config.getNextStep({ attemptIndex: attempt, lastFailure: failure, allFailures });
			if (!nextStep) break;

			if (nextStep.checkTaskStatus) {
				const abort = await this.#checkTaskAbort(task, agentName, allFailures, makeAbortResult);
				if (abort) return abort;
			}

			this.loopLog(`${agentLabel} attempt ${attempt + 1} failed for ${task.id}; retrying`, "warn", {
				taskId: task.id,
				attempt: attempt + 1,
				sessionId: failure.sessionId,
				reason: failure.reason,
			});

			currentStep = nextStep;
		}

		const failureReasonText = allFailures.map(f => f.reason).join(", ");
		return makeFailureResult(`${agentName} failed after ${allFailures.length} attempts (${failureReasonText})`);
	}

	async #runAgentAttempt(
		task: TaskIssue,
		agentName: string,
		agentLabel: string,
		spawnFn: (
			mode: "spawn" | "resume",
			resumeSessionId: string | null,
			steerMessage: string | null,
		) => Promise<AgentInfo>,
		step: RetryStep,
	): Promise<AttemptResult> {
		let agent: AgentInfo;
		const normalizedResumeSessionId = normalizeSessionId(step.resumeSessionId);
		this.lifecycleByTask.delete(task.id);

		try {
			agent = await spawnFn(step.mode, normalizedResumeSessionId, step.steerMessage);
			this.attachRpcHandlers(agent);
			this.logAgentStart(
				"OMS/system",
				agent,
				step.mode === "resume" ? `${task.title} (resume ${normalizedResumeSessionId})` : task.title,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const label = step.mode === "resume" ? `${agentLabel} resume failed` : `${agentLabel} spawn failed`;
			this.loopLog(`${label} for ${task.id}: ${message}`, "warn", {
				taskId: task.id,
				error: message,
				sessionId: normalizedResumeSessionId,
			});
			return {
				ok: false,
				reason: step.mode === "resume" ? `${agentName} resume failed` : `${agentName} spawn failed`,
				sessionId: normalizedResumeSessionId,
				missingAdvanceTool: false,
			};
		}

		const agentRpc = agent.rpc;
		const captureSessionId = (): string | null => {
			if (agentRpc && agentRpc instanceof OmsRpcClient) {
				const rpcSessionId = normalizeSessionId(agentRpc.getSessionId());
				if (rpcSessionId) return rpcSessionId;
			}
			return normalizeSessionId(agent.sessionId) ?? normalizedResumeSessionId;
		};

		if (!agentRpc || !(agentRpc instanceof OmsRpcClient)) {
			const sessionId = captureSessionId();
			await this.finishAgent(agent, "dead");
			return { ok: false, reason: `${agentName} has no rpc`, sessionId, missingAdvanceTool: false };
		}

		try {
			await agentRpc.waitForAgentEnd(900_000);
		} catch {
			const record = this.takeLifecycleRecord(task.id);
			if (record) {
				let text: string | null = null;
				try {
					text = await agentRpc.getLastAssistantText();
				} catch {
					text = null;
				}
				await this.finishAgent(agent, "done");
				await this.logAgentFinished(agent, text ?? "");
				return { ok: true, record };
			}
			const agentStatus =
				this.registry.get(agent.id)?.status === "stopped" ? ("stopped" as const) : ("dead" as const);
			const sessionId = captureSessionId();
			if (agentStatus !== "stopped") await this.finishAgent(agent, "dead");
			return { ok: false, reason: `${agentName} died`, sessionId, missingAdvanceTool: false, agentStatus };
		}

		let text: string | null = null;
		try {
			text = await agentRpc.getLastAssistantText();
		} catch {
			text = null;
		}

		const agentStatus = this.registry.get(agent.id)?.status === "stopped" ? ("stopped" as const) : undefined;

		const record = this.takeLifecycleRecord(task.id);
		await this.finishAgent(agent, "done");
		await this.logAgentFinished(agent, text ?? "");
		if (!record) {
			const sessionId = captureSessionId();
			this.loopLog(`${agentLabel} exited without advance_lifecycle for ${task.id}`, "warn", {
				taskId: task.id,
				sessionId,
				mode: step.mode,
			});
			return {
				ok: false,
				reason: `${agentName} exited without advance_lifecycle tool call`,
				sessionId,
				missingAdvanceTool: true,
				agentStatus,
			};
		}

		return { ok: true, record };
	}

	async #checkTaskAbort<TResult>(
		task: TaskIssue,
		agentName: string,
		allFailures: AttemptFailure[],
		makeAbortResult: (abortReason: string) => TResult,
	): Promise<TResult | null> {
		try {
			const currentTask = await this.tasksClient.show(task.id);
			if (currentTask.status === "closed" || currentTask.status === "blocked") {
				this.loopLog(`Task ${task.id} is ${currentTask.status}; aborting ${agentName} recovery`, "info", {
					taskId: task.id,
					status: currentTask.status,
					failureReasons: allFailures.map(f => f.reason),
				});
				return makeAbortResult(
					currentTask.status === "blocked"
						? `task blocked during ${agentName} execution`
						: `task closed during ${agentName} execution`,
				);
			}

			if (this.pendingWorkerReplacements.has(task.id)) {
				this.loopLog(`Task ${task.id} has pending worker replacement; aborting ${agentName} recovery`, "info", {
					taskId: task.id,
					failureReasons: allFailures.map(f => f.reason),
				});
				return makeAbortResult("worker replacement pending \u2014 replaced externally");
			}

			// If a worker-class agent was spawned externally (e.g. replace_agent),
			// abort the issuer retry loop so it doesn't respawn a competing issuer.
			const workerAgents = new Set(["worker", "designer", "speedy"]);
			const activeWorker = this.registry.getActiveByTask(task.id).find(a => workerAgents.has(a.agentType));
			if (activeWorker) {
				this.loopLog(
					`Task ${task.id} already has active ${activeWorker.agentType}; aborting ${agentName} recovery`,
					"info",
					{
						taskId: task.id,
						activeAgentId: activeWorker.id,
						activeAgent: activeWorker.agentType,
						failureReasons: allFailures.map(f => f.reason),
					},
				);
				return makeAbortResult("worker already active \u2014 replaced externally");
			}
		} catch (err) {
			this.loopLog(`Task ${task.id} no longer exists; aborting ${agentName} recovery`, "info", {
				taskId: task.id,
				failureReasons: allFailures.map(f => f.reason),
				error: err instanceof Error ? err.message : String(err),
			});
			return makeAbortResult(`task deleted during ${agentName} execution`);
		}
		return null;
	}

	private async runResumePipeline(task: TaskIssue): Promise<void> {
		this.loopLog(`Resuming in-progress task ${task.id} via resume decision`, "info", {
			taskId: task.id,
		});

		// Check for queued interrupt kickoff
		const forcedKickoff = this.hasPendingInterruptKickoff(task.id) ? this.takePendingInterruptKickoff(task.id) : null;

		if (forcedKickoff) {
			this.loopLog(`Resume pipeline using queued interrupt kickoff for ${task.id}`, "info", {
				taskId: task.id,
			});
		}

		let resumeDecision: ResumeDecision;
		if (forcedKickoff?.trim()) {
			resumeDecision = {
				action: "advance",
				message: forcedKickoff,
				reason: "interrupt_agent queued restart",
			};
		} else {
			const resumeIssuer = await this.runIssuerForTask(task, {
				kickoffMessage:
					"Task is already in_progress but has no active agent. " +
					'Resume from current state and call `advance_lifecycle` exactly once with action="advance" (target="worker" or "designer"), "close", or "block".',
			});
			resumeDecision = {
				action: resumeIssuer.start ? "advance" : resumeIssuer.skip ? "close" : "block",
				target: resumeIssuer.target,
				message: resumeIssuer.message,
				reason: resumeIssuer.reason,
			};
		}

		if (this.hasFinisherTakeover(task.id)) {
			this.loopLog(`Resume pipeline skipped for ${task.id}: finisher takeover active`, "info", {
				taskId: task.id,
			});
			return;
		}
		if (resumeDecision.action !== "advance") {
			// If a worker replacement is pending (replace_agent(agent=worker) was called),
			// don't block the task — spawnAgentBySingularity owns the task state.
			if (this.pendingWorkerReplacements.has(task.id)) {
				this.loopLog(`Resume pipeline aborted for ${task.id}: worker replacement pending`, "info", {
					taskId: task.id,
				});
				return;
			}
			// Secondary guard: if a worker was already spawned externally (e.g. replace_agent),
			// don't block the task — the worker owns execution now.
			const workerAgents = new Set(["worker", "designer", "speedy"]);
			const activeWorker = this.registry.getActiveByTask(task.id).find(a => workerAgents.has(a.agentType));
			if (activeWorker) {
				this.loopLog(`Resume pipeline aborted for ${task.id}: worker ${activeWorker.id} already active`, "info", {
					taskId: task.id,
					activeAgentId: activeWorker.id,
					activeAgent: activeWorker.agentType,
				});
				return;
			}
			const reason =
				resumeDecision.reason ||
				(resumeDecision.action === "close" ? "Resume issuer requested close" : "Resume restart blocked");
			try {
				await this.tasksClient.updateStatus(task.id, "blocked");
			} catch (err) {
				this.loopLog(
					`Failed to set blocked status for ${task.id}: ${err instanceof Error ? err.message : err}`,
					"warn",
					{ taskId: task.id },
				);
			}

			try {
				await this.tasksClient.comment(task.id, `Blocked during resume. ${reason}`);
			} catch (err) {
				logger.debug("loop/pipeline.ts: best-effort failure after tasksClient.comment() during resume", { err });
			}
			this.loopLog(`Resume deferred for ${task.id}: ${reason}`, "warn", {
				taskId: task.id,
				reason,
			});
			return;
		}

		if (!this.isRunning() || this.isPaused()) return;
		const normalizedTaskId = task.id.trim();
		if (
			normalizedTaskId &&
			this.getActiveWorkerAgents().some(agent => (agent.taskId ?? "").trim() === normalizedTaskId)
		) {
			this.loopLog(`Resume pipeline skipped for ${normalizedTaskId}: worker already active`, "info", {
				taskId: normalizedTaskId,
			});
			return;
		}
		const worker = await this.spawnTaskWorker(task, {
			claim: false,
			kickoffMessage: resumeDecision.message,
			target: resumeDecision.target,
		});
		this.loopLog(`Spawned task worker ${worker.id} for resume pipeline ${task.id}`, "info", {
			taskId: task.id,
			agentId: worker.id,
		});
	}

	private async runNewTaskPipeline(task: TaskIssue): Promise<void> {
		const claimed = await this.scheduler.tryClaim(task.id);
		if (!claimed) {
			this.loopLog(`Task ${task.id} was claimed before pipeline start; skipping duplicate issuer pipeline`, "info", {
				taskId: task.id,
			});
			return;
		}

		let issuerKickoffMessage: string | undefined;
		if (task.scope === "tiny") {
			const speedyResult = await this.runSpeedyForTask(task);
			if (speedyResult.done) {
				if (speedyResult.closed) {
					this.loopLog(`Fast-worker closed tiny task ${task.id}`, "info", {
						taskId: task.id,
						reason: speedyResult.message ?? speedyResult.reason,
					});
					return;
				}
				const speedyOutput =
					typeof speedyResult.message === "string" && speedyResult.message.trim()
						? speedyResult.message.trim()
						: "[Fast-worker completed without summary]";
				this.loopLog(`Fast-worker completed tiny task ${task.id}`, "info", {
					taskId: task.id,
					reason: speedyResult.reason,
				});
				try {
					const finisher = await this.spawnFinisherAfterStoppingSteering(task.id, speedyOutput);
					this.attachRpcHandlers(finisher);
					this.logAgentStart("OMS/system", finisher, "speedy completion");
					this.onDirty?.();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					this.loopLog(`Finisher spawn failed (speedy done) for ${task.id}: ${message}`, "warn", {
						taskId: task.id,
						error: message,
					});
				}
				return;
			}

			if (!speedyResult.escalate) {
				const reason = speedyResult.reason || "Fast-worker deferred start";
				try {
					await this.tasksClient.updateStatus(task.id, "blocked");
				} catch (err) {
					this.loopLog(
						`Failed to set blocked status for ${task.id}: ${err instanceof Error ? err.message : err}`,
						"warn",
						{ taskId: task.id },
					);
				}

				try {
					await this.tasksClient.comment(
						task.id,
						`Blocked by speedy. ${reason}${speedyResult.message ? `\nmessage: ${speedyResult.message}` : ""}`,
					);
				} catch (err) {
					logger.debug("loop/pipeline.ts: failed to post speedy-blocked comment (non-fatal)", { err });
				}
				this.loopLog(`Fast-worker deferred tiny task ${task.id}: ${reason}`, "warn", {
					taskId: task.id,
					reason,
				});
				return;
			}

			const escalationReason = speedyResult.reason?.trim() || "Task too complex for speedy";
			const escalationMessage = speedyResult.message?.trim() || "";
			issuerKickoffMessage = [
				"Fast-worker escalated this tiny task to full issuer lifecycle.",
				`Reason: ${escalationReason}`,
				...(escalationMessage ? [`Message: ${escalationMessage}`] : []),
			].join("\n");
			this.loopLog(`Fast-worker escalated tiny task ${task.id}`, "info", {
				taskId: task.id,
				reason: escalationReason,
			});
		}

		const result = issuerKickoffMessage
			? await this.runIssuerForTask(task, { kickoffMessage: issuerKickoffMessage })
			: await this.runIssuerForTask(task);
		if (result.skip) {
			const skipReason = result.reason || result.message || "No implementation work needed";
			const skipMessage = result.message && result.message !== skipReason ? result.message : "";
			const finisherInput =
				`[Issuer close \u2014 no worker spawned]\n\n` +
				`The issuer determined no implementation work is needed for this task.\n` +
				`Reason: ${skipReason}` +
				(skipMessage ? `\n\nIssuer message for finisher:\n${skipMessage}` : "");
			this.loopLog(`Issuer closed task ${task.id}: ${skipReason}`, "info", {
				taskId: task.id,
				reason: skipReason,
			});

			try {
				const finisher = await this.spawnFinisherAfterStoppingSteering(task.id, finisherInput);
				this.attachRpcHandlers(finisher);
				this.logAgentStart("OMS/system", finisher, `close: ${skipReason}`);
				this.onDirty?.();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.loopLog(`Finisher spawn failed (close) for ${task.id}: ${message}`, "warn", {
					taskId: task.id,
					error: message,
				});
			}
			return;
		}
		if (!result.start) {
			// If a worker replacement is pending (replace_agent(agent=worker) was called),
			// don't block the task — spawnAgentBySingularity owns the task state.
			if (this.pendingWorkerReplacements.has(task.id)) {
				this.loopLog(`New task pipeline aborted for ${task.id}: worker replacement pending`, "info", {
					taskId: task.id,
				});
				return;
			}
			// Secondary guard: if a worker was already spawned externally (e.g. replace_agent),
			// don't block the task — the worker owns execution now.
			const workerAgents = new Set(["worker", "designer", "speedy"]);
			const activeWorker = this.registry.getActiveByTask(task.id).find(a => workerAgents.has(a.agentType));
			if (activeWorker) {
				this.loopLog(`New task pipeline aborted for ${task.id}: worker ${activeWorker.id} already active`, "info", {
					taskId: task.id,
					activeAgentId: activeWorker.id,
					activeAgent: activeWorker.agentType,
				});
				return;
			}
			const reason = result.reason || "Issuer blocked task";
			try {
				await this.tasksClient.updateStatus(task.id, "blocked");
			} catch (err) {
				this.loopLog(
					`Failed to set blocked status for ${task.id}: ${err instanceof Error ? err.message : err}`,
					"warn",
					{ taskId: task.id },
				);
			}

			try {
				await this.tasksClient.comment(
					task.id,
					`Blocked by issuer. ${reason}${result.message ? `\nmessage: ${result.message}` : ""}`,
				);
			} catch (err) {
				logger.debug("loop/pipeline.ts: failed to post issuer-blocked comment (non-fatal)", { err });
			}
			this.loopLog(`Issuer blocked task ${task.id}: ${reason}`, "warn", {
				taskId: task.id,
				reason,
			});
			return;
		}
		if (!this.isRunning() || this.isPaused()) return;
		const normalizedTaskId = task.id.trim();
		if (
			normalizedTaskId &&
			this.getActiveWorkerAgents().some(agent => (agent.taskId ?? "").trim() === normalizedTaskId)
		) {
			this.loopLog(`Resume pipeline skipped for ${normalizedTaskId}: worker already active`, "info", {
				taskId: normalizedTaskId,
			});
			return;
		}

		const kickoff = result.message ?? null;

		try {
			const worker = await this.spawnTaskWorker(task, {
				claim: false,
				kickoffMessage: kickoff,
				target: result.target,
			});
			this.logAgentStart("OMS/system", worker, kickoff ?? task.title);
			this.onDirty?.();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.loopLog(`Worker spawn failed for ${task.id}: ${message}`, "warn", {
				taskId: task.id,
				error: message,
			});
		}
	}
}
