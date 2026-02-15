import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { getCapabilities } from "../core/capabilities";
import type { TaskStoreClient } from "../tasks/client";
import type { TaskIssue } from "../tasks/types";
import { logger } from "../utils";
import type { Scheduler } from "./scheduler";

type LogLevel = "debug" | "info" | "warn" | "error";

type IssuerLifecycleAction = "start" | "skip" | "defer";
type ResumeDecision = {
	action: "start" | "skip" | "defer";
	message: string | null;
	reason: string | null;
};
type IssuerLifecycleAdvanceRecord = {
	taskId: string;
	action: IssuerLifecycleAction;
	message: string | null;
	reason: string | null;
	agentId: string | null;
	ts: number;
};

function isDesignTask(issue: TaskIssue): boolean {
	const labels = Array.isArray(issue.labels) ? issue.labels : [];
	const haystack = labels.join(" ").toLowerCase();
	return /\bdesign\b|\bui\b|\bux\b|\bfigma\b|\bvisual\b|\bbrand\b/.test(haystack);
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
	private readonly runResumeSteering: (taskId: string) => Promise<ResumeDecision>;
	private readonly hasFinisherTakeover: (taskId: string) => boolean;
	private readonly spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<AgentInfo>;
	private readonly isRunning: () => boolean;
	private readonly isPaused: () => boolean;

	private readonly pipelineInFlight = new Set<string>();
	private readonly issuerLifecycleByTask = new Map<string, IssuerLifecycleAdvanceRecord>();

	constructor(opts: {
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
		runResumeSteering: (taskId: string) => Promise<ResumeDecision>;
		hasFinisherTakeover: (taskId: string) => boolean;
		spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<AgentInfo>;
		isRunning: () => boolean;
		isPaused: () => boolean;
	}) {
		this.tasksClient = opts.tasksClient;
		this.registry = opts.registry;
		this.scheduler = opts.scheduler;
		this.spawner = opts.spawner;
		this.getMaxWorkers = opts.getMaxWorkers;
		this.getActiveWorkerAgents = opts.getActiveWorkerAgents;
		this.loopLog = opts.loopLog;
		this.onDirty = opts.onDirty;
		this.wake = opts.wake;
		this.attachRpcHandlers = opts.attachRpcHandlers;
		this.finishAgent = opts.finishAgent;
		this.logAgentStart = opts.logAgentStart;
		this.logAgentFinished = opts.logAgentFinished;
		this.runResumeSteering = opts.runResumeSteering;
		this.hasFinisherTakeover = opts.hasFinisherTakeover;
		this.spawnFinisherAfterStoppingSteering = opts.spawnFinisherAfterStoppingSteering;
		this.isRunning = opts.isRunning;
		this.isPaused = opts.isPaused;
	}

	advanceIssuerLifecycle(opts: {
		taskId?: string;
		action?: string;
		message?: string;
		reason?: string;
		agentId?: string;
	}): Record<string, unknown> {
		const taskId = typeof opts.taskId === "string" ? opts.taskId.trim() : "";
		if (!taskId) {
			return { ok: false, summary: "advance_lifecycle rejected: taskId is required" };
		}

		const rawAction = typeof opts.action === "string" ? opts.action.trim().toLowerCase() : "";
		const action: IssuerLifecycleAction | null =
			rawAction === "start" || rawAction === "skip" || rawAction === "defer" ? rawAction : null;
		if (!action) {
			return {
				ok: false,
				summary: `advance_lifecycle rejected: unsupported action '${rawAction || "(empty)"}'`,
			};
		}

		const message = typeof opts.message === "string" ? opts.message.trim() : "";
		const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
		const agentId = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
		const current = this.issuerLifecycleByTask.get(taskId);
		const next: IssuerLifecycleAdvanceRecord = {
			taskId,
			action,
			message: message || null,
			reason: reason || null,
			agentId: agentId || null,
			ts: Date.now(),
		};
		this.issuerLifecycleByTask.set(taskId, next);

		// Issuer's job is done — abort it so it doesn't keep burning tokens
		const issuers = this.registry.getActiveByTask(taskId).filter(a => getCapabilities(a.role).category === "scout");
		for (const iss of issuers) {
			const rpc = iss.rpc;
			if (rpc && rpc instanceof OmsRpcClient) {
				void rpc.abort().catch(err => {
					this.loopLog("Failed to abort issuer RPC after lifecycle advance (non-fatal)", "debug", {
						taskId,
						issuerId: iss.id,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}
		}

		this.loopLog(
			current
				? `Issuer lifecycle decision updated for ${taskId}: ${current.action} -> ${action}`
				: `Issuer lifecycle decision recorded for ${taskId}: ${action}`,
			current ? "warn" : "info",
			{
				taskId,
				action,
				reason: next.reason,
				message: next.message,
				agentId: next.agentId,
			},
		);

		return {
			ok: true,
			summary: `advance_lifecycle recorded for ${taskId}: ${action}`,
			taskId,
			action,
			message: next.message,
			reason: next.reason,
			agentId: next.agentId,
		};
	}

	addPipelineInFlight(taskId: string): void {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return;
		this.pipelineInFlight.add(normalizedTaskId);
	}

	removePipelineInFlight(taskId: string): void {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return;
		this.pipelineInFlight.delete(normalizedTaskId);
	}

	isPipelineInFlight(taskId: string): boolean {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		return this.pipelineInFlight.has(normalizedTaskId);
	}

	availableWorkerSlots(): number {
		const activeWorkers = this.getActiveWorkerAgents().length;
		const reserved = this.pipelineInFlight.size;
		return Math.max(0, this.getMaxWorkers() - activeWorkers - reserved);
	}

	async runIssuerForTask(
		task: TaskIssue,
		opts?: { kickoffMessage?: string },
	): Promise<{
		start: boolean;
		skip?: boolean;
		message: string | null;
		reason: string | null;
		raw: string | null;
	}> {
		type IssuerResult = {
			start: boolean;
			skip?: boolean;
			message: string | null;
			reason: string | null;
			raw: string | null;
		};
		type IssuerAttemptResult =
			| { ok: true; result: IssuerResult }
			| { ok: false; reason: string; sessionId: string | null; missingAdvanceTool: boolean };

		const toIssuerResult = (advance: IssuerLifecycleAdvanceRecord): IssuerResult => {
			let raw: string | null = null;
			try {
				raw = JSON.stringify({
					action: advance.action,
					message: advance.message,
					reason: advance.reason,
					agentId: advance.agentId,
					ts: advance.ts,
				});
			} catch {
				raw = null;
			}

			if (advance.action === "skip") {
				return {
					start: false,
					skip: true,
					message: advance.message,
					reason: advance.reason,
					raw,
				};
			}

			if (advance.action === "defer") {
				return {
					start: false,
					message: advance.message,
					reason: advance.reason,
					raw,
				};
			}

			return {
				start: true,
				message: advance.message,
				reason: advance.reason,
				raw,
			};
		};
		const normalizeSessionId = (value: string | null | undefined): string | null => {
			if (typeof value !== "string") return null;
			const trimmed = value.trim();
			return trimmed || null;
		};
		const kickoffMessage = opts?.kickoffMessage?.trim() || "";
		const buildMissingAdvanceNudge = (): string => {
			const lines = [
				"[SYSTEM RECOVERY]",
				"Your previous issuer run ended without calling `advance_lifecycle`, so OMS could not continue.",
				'Resume this task and call `advance_lifecycle` exactly once with action="start", "skip", or "defer".',
				"Then stop.",
			];
			if (kickoffMessage) {
				lines.push("", "Original kickoff context:", kickoffMessage);
			}
			return lines.join("\n");
		};
		const runAttempt = async (
			mode: "spawn" | "resume",
			resumeSessionId?: string | null,
			steerMessage?: string | null,
		): Promise<IssuerAttemptResult> => {
			let issuer: AgentInfo;
			const normalizedResumeSessionId = normalizeSessionId(resumeSessionId);
			this.issuerLifecycleByTask.delete(task.id);

			try {
				issuer =
					mode === "resume" && normalizedResumeSessionId
						? await this.spawner.resumeAgent(
								task.id,
								normalizedResumeSessionId,
								steerMessage?.trim() || undefined,
							)
						: await this.spawner.spawnIssuer(task.id, steerMessage?.trim() || undefined);
				this.attachRpcHandlers(issuer);
				this.logAgentStart(
					"OMS/system",
					issuer,
					mode === "resume" ? `${task.title} (resume ${normalizedResumeSessionId})` : task.title,
				);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const label = mode === "resume" ? "Issuer resume failed" : "Issuer spawn failed";
				this.loopLog(`${label} for ${task.id}: ${message}`, "warn", {
					taskId: task.id,
					error: message,
					sessionId: normalizedResumeSessionId,
				});
				return {
					ok: false,
					reason: mode === "resume" ? "issuer resume failed" : "issuer spawn failed",
					sessionId: normalizedResumeSessionId,
					missingAdvanceTool: false,
				};
			}
			const issuerRpc = issuer.rpc;
			const captureSessionId = (): string | null => {
				if (issuerRpc && issuerRpc instanceof OmsRpcClient) {
					const rpcSessionId = normalizeSessionId(issuerRpc.getSessionId());
					if (rpcSessionId) return rpcSessionId;
				}
				return normalizeSessionId(issuer.sessionId) ?? normalizedResumeSessionId;
			};
			if (!issuerRpc || !(issuerRpc instanceof OmsRpcClient)) {
				const sessionId = captureSessionId();
				await this.finishAgent(issuer, "dead");
				return { ok: false, reason: "issuer has no rpc", sessionId, missingAdvanceTool: false };
			}

			try {
				await issuerRpc.waitForAgentEnd(180_000);
			} catch {
				const sessionId = captureSessionId();
				await this.finishAgent(issuer, "dead");
				return { ok: false, reason: "issuer died", sessionId, missingAdvanceTool: false };
			}
			let text: string | null = null;
			try {
				text = await issuerRpc.getLastAssistantText();
			} catch {
				text = null;
			}

			const advance = this.takeIssuerLifecycleAdvance(task.id);
			await this.finishAgent(issuer, "done");
			await this.logAgentFinished(issuer, text ?? "");
			if (!advance) {
				const sessionId = captureSessionId();
				this.loopLog(`Issuer exited without advance_lifecycle for ${task.id}`, "warn", {
					taskId: task.id,
					sessionId,
					mode,
				});
				return {
					ok: false,
					reason: "issuer exited without advance_lifecycle tool call",
					sessionId,
					missingAdvanceTool: true,
				};
			}

			return { ok: true, result: toIssuerResult(advance) };
		};

		const initialAttempt = await runAttempt("spawn", null, kickoffMessage || null);
		if (initialAttempt.ok) return initialAttempt.result;
		const initialReason = initialAttempt.reason;
		const initialSessionId = initialAttempt.sessionId;
		const missingAdvanceNudge = buildMissingAdvanceNudge();
		let resumeReason: string | null = null;
		let resumeMissingAdvance = false;
		if (initialSessionId) {
			this.loopLog(`Issuer failed for ${task.id}; attempting resume`, "warn", {
				taskId: task.id,
				sessionId: initialSessionId,
				reason: initialReason,
			});
			const resumeSteerMessage = initialAttempt.missingAdvanceTool ? missingAdvanceNudge : kickoffMessage || null;
			const resumedAttempt = await runAttempt("resume", initialSessionId, resumeSteerMessage);
			if (resumedAttempt.ok) return resumedAttempt.result;
			resumeReason = resumedAttempt.reason;
			resumeMissingAdvance = resumedAttempt.missingAdvanceTool;
			this.loopLog(`Issuer resume failed for ${task.id}; attempting fresh retry`, "warn", {
				taskId: task.id,
				sessionId: initialSessionId,
				reason: resumeReason,
			});
		} else {
			this.loopLog(`Issuer failed for ${task.id} with no recoverable session; attempting fresh retry`, "warn", {
				taskId: task.id,
				reason: initialReason,
			});
		}
		const retrySteerMessage =
			initialAttempt.missingAdvanceTool || resumeMissingAdvance ? missingAdvanceNudge : kickoffMessage || null;
		const retryAttempt = await runAttempt("spawn", null, retrySteerMessage);
		if (retryAttempt.ok) return retryAttempt.result;
		const reasonParts = [
			`initial=${initialReason}`,
			resumeReason ? `resume=${resumeReason}` : null,
			`retry=${retryAttempt.reason}`,
		].filter((part): part is string => !!part);
		return {
			start: false,
			message: null,
			reason: `issuer failed after recovery attempts (${reasonParts.join(", ")})`,
			raw: null,
		};
	}

	async spawnTaskWorker(
		issue: TaskIssue,
		opts?: { claim?: boolean; kickoffMessage?: string | null },
	): Promise<AgentInfo> {
		const design = isDesignTask(issue);
		const kickoffMessage = opts?.kickoffMessage?.trim() || undefined;
		const worker = design
			? await this.spawner.spawnDesignerWorker(issue.id, {
					claim: opts?.claim,
					kickoffMessage,
				})
			: await this.spawner.spawnWorker(issue.id, {
					claim: opts?.claim,
					kickoffMessage,
				});

		this.attachRpcHandlers(worker);

		return worker;
	}

	kickoffResumePipeline(task: TaskIssue): void {
		const taskId = task.id.trim();
		if (!taskId) return;
		if (this.pipelineInFlight.has(taskId)) {
			this.loopLog(`Resume pipeline already in-flight for ${taskId}, skipping duplicate`, "debug", {
				taskId,
			});
			return;
		}
		this.pipelineInFlight.add(taskId);
		void this.runResumePipeline(task)
			.catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				this.loopLog(`Resume pipeline failed for ${taskId}: ${message}`, "warn", {
					taskId,
					error: message,
				});
			})
			.finally(() => {
				this.pipelineInFlight.delete(taskId);
				this.onDirty?.();
				this.wake();
			});
	}

	kickoffNewTaskPipeline(task: TaskIssue): void {
		this.pipelineInFlight.add(task.id);
		void this.runNewTaskPipeline(task)
			.catch(err => {
				const message = err instanceof Error ? err.message : String(err);
				this.loopLog(`Pipeline failed for ${task.id}: ${message}`, "warn", {
					taskId: task.id,
					error: message,
				});
			})
			.finally(() => {
				this.pipelineInFlight.delete(task.id);
				this.onDirty?.();
				this.wake();
			});
	}

	private takeIssuerLifecycleAdvance(taskId: string): IssuerLifecycleAdvanceRecord | null {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return null;
		const decision = this.issuerLifecycleByTask.get(normalizedTaskId) ?? null;
		if (decision) this.issuerLifecycleByTask.delete(normalizedTaskId);
		return decision;
	}

	private async runResumePipeline(task: TaskIssue): Promise<void> {
		this.loopLog(`Resuming in-progress task ${task.id} via resume decision`, "info", {
			taskId: task.id,
		});

		const resumeDecision = await this.runResumeSteering(task.id);
		if (this.hasFinisherTakeover(task.id)) {
			this.loopLog(`Resume pipeline skipped for ${task.id}: finisher takeover active`, "info", {
				taskId: task.id,
			});
			return;
		}
		if (resumeDecision.action !== "start") {
			const reason = resumeDecision.reason || "Resume restart deferred";
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
		});
		this.logAgentStart("OMS/system", worker, resumeDecision.message ?? "resume in-progress");
		this.onDirty?.();
	}

	private async runNewTaskPipeline(task: TaskIssue): Promise<void> {
		const claimed = await this.scheduler.tryClaim(task.id);
		if (!claimed) {
			this.loopLog(`Task ${task.id} was claimed before pipeline start; skipping duplicate issuer pipeline`, "info", {
				taskId: task.id,
			});
			return;
		}
		const result = await this.runIssuerForTask(task);
		if (result.skip) {
			const skipReason = result.reason || result.message || "No implementation work needed";
			const skipMessage = result.message && result.message !== skipReason ? result.message : "";
			const finisherInput =
				`[Issuer skip — no worker spawned]\n\n` +
				`The issuer determined no implementation work is needed for this task.\n` +
				`Reason: ${skipReason}` +
				(skipMessage ? `\n\nIssuer message for finisher:\n${skipMessage}` : "");
			this.loopLog(`Issuer skipped worker for ${task.id}: ${skipReason}`, "info", {
				taskId: task.id,
				reason: skipReason,
			});

			try {
				const finisher = await this.spawnFinisherAfterStoppingSteering(task.id, finisherInput);
				this.attachRpcHandlers(finisher);
				this.logAgentStart("OMS/system", finisher, `skip: ${skipReason}`);
				this.onDirty?.();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.loopLog(`Finisher spawn failed (skip) for ${task.id}: ${message}`, "warn", {
					taskId: task.id,
					error: message,
				});
			}
			return;
		}
		if (!result.start) {
			const reason = result.reason || "Issuer deferred start";
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
			this.loopLog(`Issuer deferred task ${task.id}: ${reason}`, "warn", {
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
