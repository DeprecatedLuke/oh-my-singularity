import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentInfo } from "../agents/types";
import type { SessionLogWriter } from "../session-log-writer";
import { asRecord } from "../utils";

type LogLevel = "debug" | "info" | "warn" | "error";

function normalizeSummary(text: string, max = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	if (compact.length <= max) return compact;
	if (max <= 1) return "…";
	return `${compact.slice(0, max - 1)}…`;
}

export class LifecycleHelpers {
	private readonly registry: AgentRegistry;
	private readonly loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
	private readonly crashLogWriter?: SessionLogWriter;
	private readonly crashLoggedAgents = new Set<string>();

	constructor(opts: {
		registry: AgentRegistry;
		loopLog: (message: string, level?: LogLevel, data?: unknown) => void;
		crashLogWriter?: SessionLogWriter;
	}) {
		this.registry = opts.registry;
		this.loopLog = opts.loopLog;
		this.crashLogWriter = opts.crashLogWriter;
	}

	async getLastAssistantText(agent: AgentInfo): Promise<string> {
		const rpc = agent.rpc;
		if (!rpc || !(rpc instanceof OmsRpcClient)) return "";

		try {
			return (await rpc.getLastAssistantText()) ?? "";
		} catch {
			return "";
		}
	}

	logAgentStart(startedBy: string, agent: AgentInfo, context?: string): void {
		const ctx = normalizeSummary(context ?? "");
		const message = ctx ? `${startedBy} started ${agent.id} with "${ctx}"` : `${startedBy} started ${agent.id}`;

		this.loopLog(message, "info", {
			startedBy,
			agentId: agent.id,
			role: agent.role,
			taskId: agent.taskId,
			lifecycle: "started",
		});
	}

	async logAgentFinished(agent: AgentInfo, explicitText?: string): Promise<void> {
		const text = explicitText ?? (await this.getLastAssistantText(agent));
		const summary = normalizeSummary(text);
		const message = summary
			? `${agent.id} finished with "${summary}"`
			: `${agent.id} finished with "(no assistant output)"`;

		this.loopLog(message, "info", {
			agentId: agent.id,
			role: agent.role,
			taskId: agent.taskId,
			lifecycle: "finished",
		});
	}

	writeAgentCrashLog(agent: AgentInfo, reason: string, event?: unknown): void {
		if (!this.crashLogWriter) return;
		if (this.crashLoggedAgents.has(agent.id)) return;

		const current = this.registry.get(agent.id) ?? agent;
		const rec = asRecord(event);
		const eventError = rec && typeof rec.error === "string" ? rec.error : "";
		const rpc = current.rpc;
		const stderrTail = rpc && rpc instanceof OmsRpcClient ? rpc.getStderr().trim() : "";
		const crashPath = this.crashLogWriter.writeCrashLog({
			context: reason,
			error: eventError || event || new Error(`Agent ${current.id} (${current.role}) marked dead`),
			agent: {
				id: current.id,
				role: current.role,
				taskId: current.taskId,
				tasksAgentId: current.tasksAgentId,
				status: current.status,
				spawnedAt: current.spawnedAt,
				lastActivity: current.lastActivity,
				sessionId: current.sessionId,
				contextWindow: current.contextWindow,
				contextTokens: current.contextTokens,
				compactionCount: current.compactionCount,
			},
			recentEvents: current.events.slice(-40),
			state: {
				reason,
				exitEvent: event ?? null,
			},
			extra: {
				stderrTail,
			},
		});
		this.crashLoggedAgents.add(current.id);

		this.loopLog(
			crashPath ? `Crash log written for ${current.id}: ${crashPath}` : `Crash log write failed for ${current.id}`,
			"error",
			{ agentId: current.id, reason, crashPath, event },
		);
	}
}
