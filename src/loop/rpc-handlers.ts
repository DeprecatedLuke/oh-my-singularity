import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import { type AgentInfo, createEmptyAgentUsage } from "../agents/types";
import type { TaskStoreClient } from "../tasks/client";
import { asRecord, logger } from "../utils";
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
	private readonly revokeComplaint: (opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
		files?: string[];
		cause?: string;
	}) => Promise<Record<string, unknown>>;
	private readonly spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<AgentInfo>;
	private readonly getLastAssistantText: (agent: AgentInfo) => Promise<string>;
	private readonly logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
	private readonly logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
	private readonly writeAgentCrashLog: (agent: AgentInfo, reason: string, event?: unknown) => void;

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
		spawnFinisherAfterStoppingSteering: (taskId: string, workerOutput: string) => Promise<AgentInfo>;
		getLastAssistantText: (agent: AgentInfo) => Promise<string>;
		logAgentStart: (startedBy: string, agent: AgentInfo, context?: string) => void;
		logAgentFinished: (agent: AgentInfo, explicitText?: string) => Promise<void>;
		writeAgentCrashLog: (agent: AgentInfo, reason: string, event?: unknown) => void;
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
			const finisherOutput = await this.getLastAssistantText(agent);
			await this.logAgentFinished(agent, finisherOutput);
			await this.finishAgent(agent, "done");
			this.wake();
		}
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
