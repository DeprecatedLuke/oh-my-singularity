import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import { type AgentInfo, createEmptyAgentUsage } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import { asRecord, logger } from "../utils";
import * as UsageTracking from "./usage";

type LogLevel = "debug" | "info" | "warn" | "error";
type FinisherLifecycleAdvanceRecord = {
	taskId: string;
	action: "worker" | "issuer" | "defer";
	message: string | null;
	reason: string | null;
	agentId: string | null;
	ts: number;
};

type FinisherCloseRecord = {
	taskId: string;
	reason: string | null;
	agentId: string | null;
	ts: number;
};

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
	private readonly revokeComplaint: (opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
		files?: string[];
		cause?: string;
	}) => Promise<Record<string, unknown>>;
	private readonly spawnFinisherAfterStoppingSteering: (
		taskId: string,
		workerOutput: string,
		resumeSessionId?: string,
	) => Promise<AgentInfo>;
	private readonly getLastAssistantText: (agent: AgentInfo) => Promise<string>;
	private readonly logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
	private readonly logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
	private readonly writeAgentCrashLog: (agent: AgentInfo, reason: string, event?: unknown) => void;
	private readonly takeFinisherLifecycleAdvance: (taskId: string) => FinisherLifecycleAdvanceRecord | null;
	private readonly takeFinisherCloseRecord: (taskId: string) => FinisherCloseRecord | null;
	private readonly spawnWorkerFromFinisherAdvance: (
		taskId: string,
		kickoffMessage?: string | null,
	) => Promise<AgentInfo>;
	private readonly kickoffIssuerFromFinisherAdvance: (taskId: string, kickoffMessage?: string | null) => Promise<void>;

	private readonly rpcHandlersAttached = new Set<string>();

	constructor(opts: {
		registry: AgentRegistry;
		tasksClient: TaskStoreClient;
		loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
		onDirty?: () => void;
		isRunning: () => boolean;
		isPaused: () => boolean;
		wake: () => void;
		revokeComplaint: (opts: {
			complainantAgentId?: string;
			complainantTaskId?: string;
			files?: string[];
			cause?: string;
		}) => Promise<Record<string, unknown>>;
		spawnFinisherAfterStoppingSteering: (
			taskId: string,
			workerOutput: string,
			resumeSessionId?: string,
		) => Promise<AgentInfo>;
		getLastAssistantText: (agent: AgentInfo) => Promise<string>;
		logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
		logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
		writeAgentCrashLog: (agent: AgentInfo, reason: string, event?: unknown) => void;
		takeFinisherLifecycleAdvance: (taskId: string) => FinisherLifecycleAdvanceRecord | null;
		takeFinisherCloseRecord: (taskId: string) => FinisherCloseRecord | null;
		spawnWorkerFromFinisherAdvance: (taskId: string, kickoffMessage?: string | null) => Promise<AgentInfo>;
		kickoffIssuerFromFinisherAdvance: (taskId: string, kickoffMessage?: string | null) => Promise<void>;
	}) {
		this.registry = opts.registry;
		this.tasksClient = opts.tasksClient;
		this.loopLog = opts.loopLog;
		this.onDirty = opts.onDirty;
		this.isRunning = opts.isRunning;
		this.isPaused = opts.isPaused;
		this.wake = opts.wake;
		this.revokeComplaint = opts.revokeComplaint;
		this.spawnFinisherAfterStoppingSteering = opts.spawnFinisherAfterStoppingSteering;
		this.getLastAssistantText = opts.getLastAssistantText;
		this.logAgentStart = opts.logAgentStart;
		this.logAgentFinished = opts.logAgentFinished;
		this.writeAgentCrashLog = opts.writeAgentCrashLog;
		this.takeFinisherLifecycleAdvance = opts.takeFinisherLifecycleAdvance;
		this.takeFinisherCloseRecord = opts.takeFinisherCloseRecord;
		this.spawnWorkerFromFinisherAdvance = opts.spawnWorkerFromFinisherAdvance;
		this.kickoffIssuerFromFinisherAdvance = opts.kickoffIssuerFromFinisherAdvance;
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

		if (agent.role === "worker" || agent.role === "designer-worker") {
			if (!agent.taskId) return;

			const workerOutput = await this.getLastAssistantText(agent);
			await this.logAgentFinished(agent, workerOutput);
			try {
				const finisher = await this.spawnFinisherAfterStoppingSteering(agent.taskId, workerOutput);
				this.attachRpcHandlers(finisher);
				this.logAgentStart(agent.id, finisher, workerOutput);
			} catch {
				// Finisher spawn is best-effort.
			}

			await this.finishAgent(agent, "done");
			this.wake();
			return;
		}

		if (agent.role === "finisher") {
			const taskId = typeof agent.taskId === "string" ? agent.taskId.trim() : "";
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
			const advance = this.takeFinisherLifecycleAdvance(taskId);
			const closeRecord = this.takeFinisherCloseRecord(taskId);
			const closeTs = closeRecord?.ts ?? -1;
			const advanceTs = advance?.ts ?? -1;
			if (closeRecord && closeTs >= advanceTs) {
				this.loopLog(`Finisher exit for ${taskId}: close marker consumed`, "info", {
					taskId,
					agentId: closeRecord.agentId,
				});
				this.wake();
				return;
			}
			if (advance) {
				if (advance.action === "worker") {
					try {
						const worker = await this.spawnWorkerFromFinisherAdvance(taskId, advance.message);
						this.logAgentStart(agent.id, worker, advance.message ?? undefined);
						this.loopLog(`Finisher lifecycle advanced ${taskId} to worker`, "info", {
							taskId,
							reason: advance.reason,
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
				if (advance.action === "issuer") {
					try {
						await this.kickoffIssuerFromFinisherAdvance(taskId, advance.message);
						this.loopLog(`Finisher lifecycle advanced ${taskId} to issuer`, "info", {
							taskId,
							reason: advance.reason,
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
				const deferReason = advance.reason || "Deferred by finisher";
				await this.blockTaskFromFinisherAdvance(taskId, deferReason, advance.message);
				this.wake();
				return;
			}

			try {
				const recoveryContext = finisherSessionId
					? await this.buildFinisherResumeKickoffContext(taskId, finisherOutput, finisherSessionId)
					: this.buildFinisherRecoveryContext(finisherOutput);
				const finisher = await this.spawnFinisherAfterStoppingSteering(taskId, recoveryContext, finisherSessionId);
				this.attachRpcHandlers(finisher);
				this.logAgentStart(agent.id, finisher, "finisher retry: exited without close_task or advance_lifecycle");
				this.loopLog(`Finisher exited without lifecycle signal for ${taskId}; respawned finisher`, "warn", {
					taskId,
				});
			} catch (err) {
				this.loopLog(
					`Finisher sticky respawn failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
					"warn",
					{ taskId },
				);
			}
			this.wake();
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
			"Your previous finisher process exited without calling close_task or advance_lifecycle.",
			"Continue from the previous session history for this task.",
			`Session: ${finisherSessionId}`,
			"If complete, call close_task.",
			"If more work is needed, call advance_lifecycle with action worker, issuer, or defer.",
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
			"Your previous finisher process exited without calling close_task or advance_lifecycle.",
			"Resume lifecycle handling for this task.",
			"If complete, call close_task.",
			"If more work is needed, call advance_lifecycle with action worker, issuer, or defer.",
			"Then stop.",
		];
		const trimmedOutput = previousOutput.trim();
		if (trimmedOutput) {
			lines.push("", "Previous finisher output:", trimmedOutput);
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

		try {
			await this.revokeComplaint({
				complainantAgentId: agent.id,
				cause: `auto-revoke on agent exit (${status})`,
			});
		} catch (err) {
			logger.debug("loop/rpc-handlers.ts: best-effort failure after });", { err });
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
