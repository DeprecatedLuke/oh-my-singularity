import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import { type AgentInfo, createEmptyAgentUsage } from "../agents/types";
import { LIMIT_AGENT_MAX_RETRIES } from "../config/constants";
import type { TaskStoreClient } from "../tasks/client";
import { asRecord, logger } from "../utils";
import type { LifecycleRecord } from "./pipeline";
import * as UsageTracking from "./usage";

type LogLevel = "debug" | "info" | "warn" | "error";

function isTerminalStatus(status: string | undefined): boolean {
	return status === "done" || status === "aborted" || status === "stopped" || status === "dead";
}

function getEventType(event: unknown): string | null {
	const rec = asRecord(event);
	if (!rec) return null;
	const t = rec.type;
	return typeof t === "string" ? t : null;
}

function toFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return parsed;
}

/** Check if an event is a successful auto_compaction_end. */
function isSuccessfulCompaction(event: unknown): boolean {
	const rec = asRecord(event);
	if (!rec || rec.type !== "auto_compaction_end") return false;
	if (rec.aborted === true) return false;
	return !!rec.result;
}

/** Extract context window from a get_state response's model data. */
function extractContextWindow(stateData: unknown): number {
	const rec = asRecord(stateData);
	if (!rec) return 0;
	const model = asRecord(rec.model);
	if (!model) return 0;
	return toFiniteNumber(model.contextWindow);
}

export class RpcHandlerManager {
	private readonly registry: AgentRegistry;
	private readonly tasksClient: TaskStoreClient;
	private readonly loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
	private readonly onDirty?: () => void;
	private readonly isRunning: () => boolean;
	private readonly isPaused: () => boolean;
	private rpcDirtyDebounceMs = 150;
	private rpcDirtyLastCallAt = 0;
	private rpcDirtyDebounceTimer: Timer | null = null;

	private readonly wake: () => void;
	private readonly addLifecycleTransitionInFlight: (taskId: string) => void;
	private readonly removeLifecycleTransitionInFlight: (taskId: string) => void;
	private readonly spawnFinisherAfterStoppingSteering: (
		taskId: string,
		workerOutput: string,
		resumeSessionId?: string,
	) => Promise<AgentInfo>;
	private readonly getLastAssistantText: (agent: AgentInfo) => Promise<string>;
	private readonly logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
	private readonly logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
	private readonly writeAgentCrashLog: (agent: AgentInfo, reason: string, event?: unknown) => void;
	private readonly takeLifecycleRecord: (taskId: string) => LifecycleRecord | null;
	private readonly hasLifecycleRecord: (taskId: string) => boolean;
	private readonly spawnWorkerFromFinisherAdvance: (
		taskId: string,
		kickoffMessage?: string | null,
	) => Promise<AgentInfo>;
	private readonly kickoffIssuerFromFinisherAdvance: (taskId: string, kickoffMessage?: string | null) => Promise<void>;
	private readonly spawnWorkerForRetry: (agent: AgentInfo, recoveryContext: string) => Promise<AgentInfo>;

	private readonly rpcHandlersAttached = new Set<string>();
	private readonly retryAttemptsByTypeAndTask = new Map<string, number>();

	private retryKey(agentType: string, taskId: string): string {
		return `${agentType}:${taskId}`;
	}
	private incrementRetryAttempts(agentType: string, taskId: string): number {
		const key = this.retryKey(agentType, taskId);
		const count = (this.retryAttemptsByTypeAndTask.get(key) ?? 0) + 1;
		this.retryAttemptsByTypeAndTask.set(key, count);
		return count;
	}

	private clearRetryAttempts(agentType: string, taskId: string): void {
		this.retryAttemptsByTypeAndTask.delete(this.retryKey(agentType, taskId));
	}

	constructor(opts: {
		registry: AgentRegistry;
		tasksClient: TaskStoreClient;
		loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
		onDirty?: () => void;
		isRunning: () => boolean;
		isPaused: () => boolean;
		wake: () => void;
		addLifecycleTransitionInFlight: (taskId: string) => void;
		removeLifecycleTransitionInFlight: (taskId: string) => void;
		spawnFinisherAfterStoppingSteering: (
			taskId: string,
			workerOutput: string,
			resumeSessionId?: string,
		) => Promise<AgentInfo>;
		getLastAssistantText: (agent: AgentInfo) => Promise<string>;
		logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
		logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
		writeAgentCrashLog: (agent: AgentInfo, reason: string, event?: unknown) => void;
		takeLifecycleRecord: (taskId: string) => LifecycleRecord | null;
		hasLifecycleRecord: (taskId: string) => boolean;
		spawnWorkerFromFinisherAdvance: (taskId: string, kickoffMessage?: string | null) => Promise<AgentInfo>;
		kickoffIssuerFromFinisherAdvance: (taskId: string, kickoffMessage?: string | null) => Promise<void>;
		spawnWorkerForRetry: (agent: AgentInfo, recoveryContext: string) => Promise<AgentInfo>;
	}) {
		this.registry = opts.registry;
		this.tasksClient = opts.tasksClient;
		this.loopLog = opts.loopLog;
		this.onDirty = opts.onDirty;
		this.isRunning = opts.isRunning;
		this.isPaused = opts.isPaused;
		this.wake = opts.wake;
		this.addLifecycleTransitionInFlight = opts.addLifecycleTransitionInFlight;
		this.removeLifecycleTransitionInFlight = opts.removeLifecycleTransitionInFlight;
		this.spawnFinisherAfterStoppingSteering = opts.spawnFinisherAfterStoppingSteering;
		this.getLastAssistantText = opts.getLastAssistantText;
		this.logAgentStart = opts.logAgentStart;
		this.logAgentFinished = opts.logAgentFinished;
		this.writeAgentCrashLog = opts.writeAgentCrashLog;
		this.takeLifecycleRecord = opts.takeLifecycleRecord;
		this.hasLifecycleRecord = opts.hasLifecycleRecord;
		this.spawnWorkerFromFinisherAdvance = opts.spawnWorkerFromFinisherAdvance;
		this.kickoffIssuerFromFinisherAdvance = opts.kickoffIssuerFromFinisherAdvance;
		this.spawnWorkerForRetry = opts.spawnWorkerForRetry;
	}
	private debounceRpcDirty(): void {
		if (!this.onDirty) return;

		const now = Date.now();
		const elapsed = now - this.rpcDirtyLastCallAt;

		// Leading edge: call immediately if first call or after quiet period
		if (elapsed >= this.rpcDirtyDebounceMs || this.rpcDirtyLastCallAt === 0) {
			this.rpcDirtyLastCallAt = now;
			this.onDirty();
		}

		// Trailing edge: schedule call after debounce window to catch end of burst
		if (this.rpcDirtyDebounceTimer) {
			clearTimeout(this.rpcDirtyDebounceTimer);
		}
		this.rpcDirtyDebounceTimer = setTimeout(() => {
			this.rpcDirtyDebounceTimer = null;
			this.rpcDirtyLastCallAt = Date.now();
			this.onDirty?.();
		}, this.rpcDirtyDebounceMs);
	}

	attachRpcHandlers(agent: AgentInfo): void {
		const rpc = agent.rpc;
		if (!rpc || !(rpc instanceof OmsRpcClient)) return;

		if (this.rpcHandlersAttached.has(agent.id)) return;
		this.rpcHandlersAttached.add(agent.id);

		rpc.onEvent(event => {
			const type = getEventType(event);
			this.registry.pushEvent(agent.id, {
				type: "rpc",
				ts: Date.now(),
				name: type ?? "(unknown)",
				data: event,
			});
			if (typeof this.tasksClient.recordAgentEvent === "function") {
				void this.tasksClient.recordAgentEvent(agent.tasksAgentId || agent.id, event, agent.taskId).catch(err => {
					this.loopLog("Failed to record agent event (non-fatal)", "debug", {
						agentId: agent.id,
						taskId: agent.taskId ?? null,
						error: err instanceof Error ? err.message : String(err),
					});
				});
			}

			const current = this.registry.get(agent.id);
			const usageDelta = UsageTracking.extractAssistantUsageDelta(event);
			if (usageDelta && current) UsageTracking.applyUsageDelta(current, usageDelta);

			// Track context token usage (cumulative input = context consumed)
			const ctxTokens = UsageTracking.extractContextTokens(event);
			if (ctxTokens !== null && current) {
				current.contextTokens = ctxTokens;
			}

			// Track successful compaction events
			if (isSuccessfulCompaction(event) && current) {
				current.compactionCount = (current.compactionCount ?? 0) + 1;
			}

			const sessionId = rpc.getSessionId();
			if (current && typeof sessionId === "string" && sessionId.trim()) {
				current.sessionId = sessionId.trim();
			}
			if (current && usageDelta && typeof this.tasksClient.recordAgentUsage === "function") {
				const usage = current.usage ?? createEmptyAgentUsage();
				void this.tasksClient
					.recordAgentUsage(
						agent.tasksAgentId || agent.id,
						{
							input: usage.input,
							output: usage.output,
							cacheRead: usage.cacheRead,
							cacheWrite: usage.cacheWrite,
							totalTokens: usage.totalTokens,
							cost: usage.cost,
						},
						agent.taskId,
					)
					.catch(err => {
						this.loopLog("Failed to record agent usage snapshot (non-fatal)", "debug", {
							agentId: agent.id,
							taskId: agent.taskId ?? null,
							error: err instanceof Error ? err.message : String(err),
						});
					});
			}

			this.debounceRpcDirty();

			if (type === "agent_end") {
				void this.onAgentEnd(agent);
			}

			if (type === "rpc_exit") {
				void this.onRpcExit(agent, event);
			}
		});

		// Fetch context window from model info (best-effort, async)
		void rpc
			.getState()
			.then(stateData => {
				const current = this.registry.get(agent.id);
				if (!current) return;
				const ctxWindow = extractContextWindow(stateData);
				if (ctxWindow > 0) {
					current.contextWindow = ctxWindow;
					this.onDirty?.();
				}
			})
			.catch(err => {
				this.loopLog("Failed to read RPC state for context window (non-fatal)", "debug", {
					agentId: agent.id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	private async onAgentEnd(agent: AgentInfo): Promise<void> {
		if (!this.isRunning()) return;
		if (this.isPaused()) return;

		// Guard: if the agent is already in a terminal state (e.g. being stopped by
		// stopAgentsMatching), do not spawn a finisher. The abort() call is fire-and-forget
		// and can trigger agent_end before finishAgent marks the agent as stopped.
		const current = this.registry.get(agent.id);
		if (current && isTerminalStatus(current.status)) {
			this.wake();
			return;
		}

		if (agent.agentType === "worker" || agent.agentType === "designer") {
			const taskId = typeof agent.taskId === "string" ? agent.taskId.trim() : "";
			if (!taskId) return;
			// Hold lifecycle transition flag for the entire onAgentEnd processing.
			// Without this, a periodic tick can see the task as in_progress with no
			// active agent (after finishAgent but before finisher spawn) and start
			// a resume pipeline (issuer) instead of advancing to finisher.
			this.addLifecycleTransitionInFlight(taskId);
			try {
				const workerOutput = await this.getLastAssistantText(agent);
				const workerSessionId =
					typeof current?.sessionId === "string" && current.sessionId.trim()
						? current.sessionId.trim()
						: typeof agent.sessionId === "string" && agent.sessionId.trim()
							? agent.sessionId.trim()
							: undefined;
				await this.logAgentFinished(agent, workerOutput);
				await this.finishAgent(agent, "done");
				const advance = this.takeLifecycleRecord(taskId);
				if (advance) {
					this.clearRetryAttempts("worker", taskId);
					try {
						const finisher = await this.spawnFinisherAfterStoppingSteering(taskId, workerOutput);
						this.attachRpcHandlers(finisher);
						this.logAgentStart(agent.id, finisher, workerOutput);
						this.loopLog(`Worker lifecycle advanced ${taskId} to finisher`, "info", {
							taskId,
							action: advance.action,
							reason: advance.reason,
						});
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						this.loopLog(`Finisher spawn failed after worker advance for ${taskId}: ${msg}`, "warn", {
							taskId,
							error: msg,
						});
						// Block the task so the resume pipeline doesn't start an issuer loop.
						try {
							await this.tasksClient.updateStatus(taskId, "blocked");
							await this.tasksClient.comment(
								taskId,
								`Blocked: finisher spawn failed after worker advance. ${msg}`,
							);
						} catch {
							// best-effort
						}
					}
					this.wake();
					return;
				}
				const failedAttempts = this.incrementRetryAttempts("worker", taskId);
				this.loopLog(
					`Worker/designer exited without lifecycle signal for ${taskId}; attempt ${failedAttempts}/${LIMIT_AGENT_MAX_RETRIES}`,
					"warn",
					{
						taskId,
						attempt: failedAttempts,
						maxRetries: LIMIT_AGENT_MAX_RETRIES,
					},
				);
				if (failedAttempts >= LIMIT_AGENT_MAX_RETRIES) {
					this.loopLog(`Worker/designer retries exhausted for ${taskId}; blocking task`, "warn", {
						taskId,
						attempt: failedAttempts,
						maxRetries: LIMIT_AGENT_MAX_RETRIES,
					});
					await this.blockTaskFromWorkerRetry(
						taskId,
						`Worker/designer retries exhausted after ${LIMIT_AGENT_MAX_RETRIES} attempts without advance_lifecycle signal`,
						`Worker/designer exited without advance_lifecycle ${failedAttempts} consecutive times.`,
					);
					this.clearRetryAttempts("worker", taskId);
					this.wake();
					return;
				}

				try {
					const recoveryContext = this.buildWorkerRecoveryContext(workerOutput, workerSessionId);
					const retried = await this.spawnWorkerForRetry(agent, recoveryContext);
					this.attachRpcHandlers(retried);
					this.logAgentStart(agent.id, retried, "worker retry: exited without advance_lifecycle");
					this.loopLog(`Worker/designer exited without lifecycle signal for ${taskId}; respawned worker`, "warn", {
						taskId,
						attempt: failedAttempts,
						maxRetries: LIMIT_AGENT_MAX_RETRIES,
					});
				} catch (err) {
					this.loopLog(
						`Worker/designer retry spawn failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
						"warn",
						{ taskId, attempt: failedAttempts, maxRetries: LIMIT_AGENT_MAX_RETRIES },
					);
				}
				this.wake();
			} finally {
				this.removeLifecycleTransitionInFlight(taskId);
			}
			return;
		}

		if (agent.agentType === "finisher") {
			const taskId = typeof agent.taskId === "string" ? agent.taskId.trim() : "";
			if (taskId) this.addLifecycleTransitionInFlight(taskId);
			try {
				const finisherOutput = await this.getLastAssistantText(agent);
				const finisherSessionId =
					typeof current?.sessionId === "string" && current.sessionId.trim()
						? current.sessionId.trim()
						: typeof agent.sessionId === "string" && agent.sessionId.trim()
							? agent.sessionId.trim()
							: undefined;
				await this.logAgentFinished(agent, finisherOutput);
				await this.finishAgent(agent, "done");
				if (!taskId) {
					this.wake();
					return;
				}
				const record = this.takeLifecycleRecord(taskId);
				if (record && record.action === "close") {
					this.clearRetryAttempts("finisher", taskId);
					this.loopLog(`Finisher exit for ${taskId}: close marker consumed`, "info", {
						taskId,
						agentId: record.agentId,
					});
					this.wake();
					return;
				}
				if (record && record.action === "advance") {
					this.clearRetryAttempts("finisher", taskId);
					if (record.target === "worker") {
						try {
							const worker = await this.spawnWorkerFromFinisherAdvance(taskId, record.message);
							this.logAgentStart(agent.id, worker, record.message ?? undefined);
							this.loopLog(`Finisher lifecycle advanced ${taskId} to worker`, "info", {
								taskId,
								reason: record.reason,
							});
						} catch (err) {
							this.loopLog(
								`Finisher lifecycle worker spawn failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
								"warn",
								{ taskId },
							);
						}
						this.wake();
						return;
					}
					if (record.target === "issuer") {
						try {
							await this.kickoffIssuerFromFinisherAdvance(taskId, record.message);
							this.loopLog(`Finisher lifecycle advanced ${taskId} to issuer`, "info", {
								taskId,
								reason: record.reason,
							});
						} catch (err) {
							this.loopLog(
								`Finisher lifecycle issuer kickoff failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
								"warn",
								{ taskId },
							);
						}
						this.wake();
						return;
					}
				}
				if (record && record.action === "block") {
					this.clearRetryAttempts("finisher", taskId);
					const blockReason = record.reason || "Blocked by finisher";
					await this.blockTaskFromFinisherAdvance(taskId, blockReason, record.message);
					this.wake();
					return;
				}
				const failedAttempts = this.incrementRetryAttempts("finisher", taskId);
				this.loopLog(
					`Finisher exited without lifecycle signal for ${taskId}; attempt ${failedAttempts}/${LIMIT_AGENT_MAX_RETRIES}`,
					"warn",
					{
						taskId,
						attempt: failedAttempts,
						maxRetries: LIMIT_AGENT_MAX_RETRIES,
					},
				);
				if (failedAttempts >= LIMIT_AGENT_MAX_RETRIES) {
					this.loopLog(`Finisher retries exhausted for ${taskId}; blocking task`, "warn", {
						taskId,
						attempt: failedAttempts,
						maxRetries: LIMIT_AGENT_MAX_RETRIES,
					});
					await this.blockTaskFromFinisherAdvance(
						taskId,
						`Finisher retries exhausted after ${LIMIT_AGENT_MAX_RETRIES} attempts without lifecycle signal`,
						`Finisher exited without advance_lifecycle ${failedAttempts} consecutive times.`,
					);
					this.clearRetryAttempts("finisher", taskId);
					this.wake();
					return;
				}

				try {
					const recoveryContext = finisherSessionId
						? await this.buildFinisherResumeKickoffContext(taskId, finisherOutput, finisherSessionId)
						: this.buildFinisherRecoveryContext(finisherOutput);
					const finisher = await this.spawnFinisherAfterStoppingSteering(
						taskId,
						recoveryContext,
						finisherSessionId,
					);
					this.attachRpcHandlers(finisher);
					this.logAgentStart(agent.id, finisher, "finisher retry: exited without advance_lifecycle");
					this.loopLog(`Finisher exited without lifecycle signal for ${taskId}; respawned finisher`, "warn", {
						taskId,
						attempt: failedAttempts,
						maxRetries: LIMIT_AGENT_MAX_RETRIES,
					});
				} catch (err) {
					this.loopLog(
						`Finisher sticky respawn failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
						"warn",
						{ taskId, attempt: failedAttempts, maxRetries: LIMIT_AGENT_MAX_RETRIES },
					);
				}
				this.wake();
			} finally {
				if (taskId) this.removeLifecycleTransitionInFlight(taskId);
			}
			return;
		}
	}

	private async blockTaskFromFinisherAdvance(taskId: string, reason: string, message: string | null): Promise<void> {
		try {
			await this.tasksClient.updateStatus(taskId, "blocked");
		} catch (err) {
			this.loopLog(
				`Failed to set blocked status for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
				"warn",
				{ taskId },
			);
		}

		try {
			await this.tasksClient.comment(
				taskId,
				`Blocked by finisher advance_lifecycle. ${reason}${message ? `\nmessage: ${message}` : ""}`,
			);
		} catch (err) {
			logger.debug("loop/rpc-handlers.ts: failed to post finisher defer comment (non-fatal)", { err });
		}

		this.loopLog(`Finisher lifecycle deferred ${taskId}: ${reason}`, "warn", {
			taskId,
			reason,
		});
	}

	private async buildFinisherResumeKickoffContext(
		taskId: string,
		previousOutput: string,
		finisherSessionId: string,
	): Promise<string> {
		const taskLookup = (await this.tasksClient.show(taskId).catch(() => null)) as Record<string, unknown> | null;
		const task =
			taskLookup ??
			({
				id: taskId,
				title: taskId,
				status: "unknown",
				issue_type: "task",
				labels: [],
			} as Record<string, unknown>);

		const lines = [
			"[SYSTEM RESUME]",
			"Your previous finisher process exited without calling advance_lifecycle.",
			"Continue from the previous session history for this task.",
			`Session: ${finisherSessionId}`,
			'If complete, call advance_lifecycle with action="close".',
			'If more work is needed, call advance_lifecycle with action="advance" (target="worker" or "issuer") or action="block".',
			"Then stop.",
		];

		const status = typeof task.status === "string" && task.status.trim() ? task.status.trim() : "unknown";
		const assignee = typeof task.assignee === "string" && task.assignee.trim() ? task.assignee.trim() : "unassigned";
		const priority =
			typeof task.priority === "number" && Number.isFinite(task.priority) ? `${task.priority}` : "unknown";
		const title = typeof task.title === "string" && task.title.trim() ? task.title.trim() : taskId;
		const issueType =
			typeof task.issue_type === "string" && task.issue_type.trim() ? task.issue_type.trim() : "unknown";
		const labelsRaw = Array.isArray(task.labels)
			? task.labels.map(label => (typeof label === "string" ? label.trim() : "")).filter(Boolean)
			: [];

		lines.push(
			"",
			"Task state:",
			`- id: ${taskId}`,
			`- title: ${title}`,
			`- status: ${status}`,
			`- assignee: ${assignee}`,
			`- priority: ${priority}`,
			`- issue_type: ${issueType}`,
		);
		if (labelsRaw.length > 0) {
			lines.push(`- labels: ${labelsRaw.join(", ")}`);
		}

		let comments: unknown[] = [];
		if (Array.isArray(task.comments)) {
			comments = task.comments;
		} else {
			comments = await this.tasksClient.comments(taskId).catch(() => []);
		}

		const formattedComments = comments
			.map(entry => asRecord(entry))
			.filter((entry): entry is Record<string, unknown> => !!entry)
			.map(entry => {
				const author = typeof entry.author === "string" && entry.author.trim() ? entry.author.trim() : "unknown";
				const createdAt =
					typeof entry.created_at === "string" && entry.created_at.trim() ? entry.created_at.trim() : "unknown";
				const text = typeof entry.text === "string" && entry.text.trim() ? entry.text.trim() : "";
				return { author, createdAt, text };
			})
			.filter(entry => entry.text || entry.author !== "unknown");

		const finisherComments = formattedComments.filter(entry => entry.author.toLowerCase().includes("finisher"));
		const commentTrail = (finisherComments.length > 0 ? finisherComments : formattedComments)
			.slice(-6)
			.flatMap(entry => {
				const commentLines: string[] = [`- ${entry.author} (${entry.createdAt}):`];
				if (!entry.text) return commentLines;
				for (const line of entry.text.replace(/\r\n?/g, "\n").split("\n")) {
					commentLines.push(`  ${line}`);
				}
				return commentLines;
			});

		if (commentTrail.length > 0) {
			lines.push("", "Recent task comments:");
			for (const line of commentTrail) {
				lines.push(line);
			}
		}

		const trimmedOutput = previousOutput.trim();
		if (trimmedOutput) {
			lines.push("", "Previous finisher output:", trimmedOutput);
		}

		return lines.join("\n");
	}

	private buildFinisherRecoveryContext(previousOutput: string): string {
		const lines = [
			"[SYSTEM RECOVERY]",
			"Your previous finisher process exited without calling advance_lifecycle.",
			"Resume lifecycle handling for this task.",
			'If complete, call advance_lifecycle with action="close".',
			'If more work is needed, call advance_lifecycle with action="advance" (target="worker" or "issuer") or action="block".',
			"Then stop.",
		];
		const trimmedOutput = previousOutput.trim();
		if (trimmedOutput) {
			lines.push("", "Previous finisher output:", trimmedOutput);
		}
		return lines.join("\n");
	}

	private async blockTaskFromWorkerRetry(taskId: string, reason: string, message: string | null): Promise<void> {
		try {
			await this.tasksClient.updateStatus(taskId, "blocked");
		} catch (err) {
			this.loopLog(
				`Failed to set blocked status for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
				"warn",
				{ taskId },
			);
		}

		try {
			await this.tasksClient.comment(
				taskId,
				`Blocked by worker advance_lifecycle. ${reason}${message ? `\nmessage: ${message}` : ""}`,
			);
		} catch (err) {
			logger.debug("loop/rpc-handlers.ts: failed to post worker retry exhaustion comment (non-fatal)", { err });
		}

		this.loopLog(`Worker/designer retry exhausted ${taskId}: ${reason}`, "warn", {
			taskId,
			reason,
		});
	}

	private buildWorkerRecoveryContext(previousOutput: string, sessionId?: string): string {
		const lines = [
			"[SYSTEM RECOVERY]",
			"Your previous worker process exited without calling advance_lifecycle.",
			"Resume your work for this task.",
			'When implementation is complete, call advance_lifecycle with action="advance", target="finisher".',
			"Then stop.",
		];
		if (sessionId) {
			lines.push(`Session: ${sessionId}`);
		}
		const trimmedOutput = previousOutput.trim();
		if (trimmedOutput) {
			lines.push("", "Previous worker output:", trimmedOutput);
		}
		return lines.join("\n");
	}

	private async onRpcExit(agent: AgentInfo, event: unknown): Promise<void> {
		const rec = asRecord(event);
		const exitCode = rec && typeof rec.exitCode === "number" ? rec.exitCode : null;
		const rpcExitError = rec && typeof rec.error === "string" ? rec.error.trim() : "";
		const current = this.registry.get(agent.id);
		if (current && isTerminalStatus(current.status)) {
			this.wake();
			return;
		}

		// Safety net: if the process crashed after the agent called advance_lifecycle
		// but before agent_end could fire, the lifecycle record would be orphaned.
		// Delegate to onAgentEnd so the record is consumed and the next agent spawns.
		const taskId = typeof agent.taskId === "string" ? agent.taskId.trim() : "";
		if (
			taskId &&
			(agent.agentType === "worker" || agent.agentType === "designer" || agent.agentType === "finisher") &&
			this.hasLifecycleRecord(taskId)
		) {
			this.loopLog(
				`rpc_exit for ${agent.agentType} ${agent.id} with pending lifecycle record; delegating to onAgentEnd`,
				"debug",
				{
					taskId,
					agentId: agent.id,
					exitCode,
				},
			);
			void this.onAgentEnd(agent);
			return;
		}
		const nextStatus = exitCode === 0 && !rpcExitError ? "done" : "dead";
		await this.finishAgent(
			agent,
			nextStatus,
			nextStatus === "dead"
				? {
						crashReason: rpcExitError
							? `rpc_exit error=${rpcExitError}`
							: `rpc_exit exitCode=${exitCode ?? "unknown"}`,
						crashEvent: event,
					}
				: undefined,
		);
		await this.logAgentFinished(agent);
		this.wake();
	}

	async finishAgent(
		agent: AgentInfo,
		status: "done" | "stopped" | "dead",
		opts?: { crashReason?: string; crashEvent?: unknown },
	): Promise<void> {
		const current = this.registry.get(agent.id);
		if (current) {
			current.status = status;
			current.lastActivity = Date.now();
		}

		if (status === "dead") {
			this.writeAgentCrashLog(agent, opts?.crashReason ?? "agent marked dead", opts?.crashEvent);
		}

		if (agent.tasksAgentId?.trim()) {
			try {
				await this.tasksClient.setAgentState(agent.tasksAgentId, status);
			} catch (err) {
				logger.debug(
					"loop/rpc-handlers.ts: best-effort failure after await this.tasksClient.setAgentState(agent.tasksAgentId, status);",
					{ err },
				);
			}

			try {
				await this.tasksClient.clearSlot(agent.tasksAgentId, "hook");
			} catch (err) {
				logger.debug(
					'loop/rpc-handlers.ts: best-effort failure after await this.tasksClient.clearSlot(agent.tasksAgentId, "hook");',
					{ err },
				);
			}
		}

		const rpc = agent.rpc;
		if (rpc && rpc instanceof OmsRpcClient) {
			try {
				await rpc.stop();
			} catch (err) {
				logger.debug("loop/rpc-handlers.ts: best-effort failure after await rpc.stop();", { err });
			}
		}

		this.onDirty?.();
	}
}
