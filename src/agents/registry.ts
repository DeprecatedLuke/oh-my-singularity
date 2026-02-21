import {
	LIMIT_AGENT_EVENT_BUFFER,
	LIMIT_MESSAGE_HISTORY_DEFAULT,
	LIMIT_MESSAGE_HISTORY_MAX,
	TIMEOUT_REGISTRY_DEFAULT_INTERVAL_MS,
} from "../config/constants";
import type { TaskStoreClient } from "../tasks/client";
import { asRecord, logger } from "../utils";
import { OmsRpcClient } from "./rpc-wrapper";
import type { AgentEvent, AgentInfo, AgentStatus, AgentType } from "./types";

function isActiveStatus(status: AgentStatus): boolean {
	// Keep conservative: only treat clearly-terminal states as inactive.
	return !(
		status === "done" ||
		status === "failed" ||
		status === "aborted" ||
		status === "stopped" ||
		status === "dead"
	);
}

type ToolCallSummary = {
	id: string | null;
	name: string;
	input: unknown;
	result: unknown;
	resultError: boolean;
};

type RegistryEventListener = (agentId: string, event: AgentEvent) => void;

function getAgentLookupCandidates(agentId: string): string[] {
	const trimmed = agentId.trim();
	if (!trimmed) return [];
	const out = [trimmed];
	const parts = trimmed
		.split(":")
		.map(part => part.trim())
		.filter(Boolean);
	const tail = parts[parts.length - 1];
	if (tail && tail !== trimmed) out.push(tail);
	return out;
}

function extractToolCalls(messages: unknown[]): ToolCallSummary[] {
	const out: ToolCallSummary[] = [];
	const byId = new Map<string, ToolCallSummary>();

	for (const message of messages) {
		const rec = asRecord(message);
		if (!rec) continue;

		const role = typeof rec.role === "string" ? rec.role : "";
		if (role === "assistant") {
			const content = Array.isArray(rec.content) ? rec.content : [rec.content];
			for (const block of content) {
				const b = asRecord(block);
				if (!b || b.type !== "tool_use") continue;

				const name = typeof b.name === "string" ? b.name : "(unknown)";
				const id = typeof b.id === "string" ? b.id : null;
				const call: ToolCallSummary = {
					id,
					name,
					input: b.input ?? b.arguments ?? null,
					result: null,
					resultError: false,
				};
				out.push(call);
				if (id) byId.set(id, call);
			}
			continue;
		}

		if (role === "tool") {
			const toolUseId = typeof rec.tool_use_id === "string" ? rec.tool_use_id : null;
			if (!toolUseId) continue;
			const call = byId.get(toolUseId);
			if (!call) continue;
			call.result = rec.content ?? null;
			call.resultError = rec.is_error === true;
		}
	}

	return out;
}

export class AgentRegistry {
	private readonly agents = new Map<string, AgentInfo>();
	private readonly taskIndex = new Map<string, Set<string>>();
	private _generation = 0;
	private readonly tasksClient: TaskStoreClient;
	private readonly intervalMs: number;
	private readonly eventLimit: number;
	private readonly tasksAvailable: boolean;

	private heartbeatTimer: Timer | null = null;
	private heartbeatInFlight: Promise<void> | null = null;
	private readonly eventListeners = new Set<RegistryEventListener>();

	get generation(): number {
		return this._generation;
	}

	private indexAgent(agentId: string, taskId: string | null | undefined): void {
		if (!taskId) return;
		let set = this.taskIndex.get(taskId);
		if (!set) {
			set = new Set();
			this.taskIndex.set(taskId, set);
		}
		set.add(agentId);
	}

	private unindexAgent(agentId: string, taskId: string | null | undefined): void {
		if (!taskId) return;
		const set = this.taskIndex.get(taskId);
		if (!set) return;
		set.delete(agentId);
		if (set.size === 0) this.taskIndex.delete(taskId);
	}

	constructor(opts: {
		tasksClient: TaskStoreClient;
		intervalMs?: number;
		eventLimit?: number;
		tasksAvailable?: boolean;
	}) {
		this.tasksClient = opts.tasksClient;
		this.intervalMs = opts.intervalMs ?? TIMEOUT_REGISTRY_DEFAULT_INTERVAL_MS;
		this.eventLimit = opts.eventLimit ?? LIMIT_AGENT_EVENT_BUFFER;
		this.tasksAvailable = opts.tasksAvailable ?? true;
	}

	isTasksAvailable(): boolean {
		return this.tasksAvailable;
	}

	onEvent(listener: RegistryEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	register(info: AgentInfo): AgentInfo {
		const existing = this.agents.get(info.id);
		if (!existing) {
			this.agents.set(info.id, info);
			this.indexAgent(info.id, info.taskId);
			this._generation++;
			return info;
		}
		// Upsert semantics: merge, but keep existing events unless overwritten.
		const merged: AgentInfo = {
			...existing,
			...info,
			events: info.events ?? existing.events,
			lastActivity: (info.events?.length ?? 0) > 0 ? Math.max(info.lastActivity, Date.now()) : info.lastActivity,
		};

		if (existing.taskId !== merged.taskId) {
			this.unindexAgent(existing.id, existing.taskId);
			this.indexAgent(info.id, merged.taskId);
		}
		this.agents.set(info.id, merged);
		this._generation++;
		return merged;
	}

	remove(id: string): boolean {
		const agent = this.agents.get(id);
		if (agent) {
			this.unindexAgent(id, agent.taskId);
		}
		const deleted = this.agents.delete(id);
		if (deleted) this._generation++;
		return deleted;
	}

	get(id: string): AgentInfo | undefined {
		return this.agents.get(id);
	}

	getByTasksAgentId(tasksAgentId: string): AgentInfo | undefined {
		const normalized = tasksAgentId.trim();
		if (!normalized) return undefined;
		for (const agent of this.agents.values()) {
			if (agent.tasksAgentId === normalized) return agent;
		}
		return undefined;
	}

	getByTask(taskId: string): AgentInfo[] {
		const set = this.taskIndex.get(taskId);
		if (!set) return [];
		const out: AgentInfo[] = [];
		for (const id of set) {
			const agent = this.agents.get(id);
			if (agent) out.push(agent);
		}
		return out;
	}

	getActiveByTask(taskId: string): AgentInfo[] {
		const set = this.taskIndex.get(taskId);
		if (!set) return [];
		const out: AgentInfo[] = [];
		for (const id of set) {
			const agent = this.agents.get(id);
			if (agent && isActiveStatus(agent.status)) out.push(agent);
		}
		return out;
	}

	getByAgentType(agentType: AgentType): AgentInfo[] {
		const out: AgentInfo[] = [];
		for (const agent of this.agents.values()) {
			if (agent.agentType === agentType) out.push(agent);
		}
		return out;
	}

	getActive(): AgentInfo[] {
		const out: AgentInfo[] = [];
		for (const agent of this.agents.values()) {
			if (isActiveStatus(agent.status)) out.push(agent);
		}
		return out;
	}

	getAll(): AgentInfo[] {
		return [...this.agents.values()];
	}

	listActiveSummaries(): Array<{
		id: string;
		agentType: AgentType;
		taskId: string | null;
		status: AgentStatus;
		lastActivity: number;
	}> {
		return this.getActive().map(agent => ({
			id: agent.id,
			agentType: agent.agentType,
			taskId: agent.taskId,
			status: agent.status,
			lastActivity: agent.lastActivity,
		}));
	}

	async readMessageHistory(
		agentId: string,
		limit = LIMIT_MESSAGE_HISTORY_DEFAULT,
	): Promise<{
		agent: {
			id: string;
			agentType: AgentType;
			taskId: string | null;
			status: AgentStatus;
		} | null;
		messages: unknown[];
		toolCalls: ToolCallSummary[];
	}> {
		const parsedLimit = Number(limit);
		const max =
			Number.isFinite(parsedLimit) && parsedLimit > 0
				? Math.min(LIMIT_MESSAGE_HISTORY_MAX, Math.trunc(parsedLimit))
				: LIMIT_MESSAGE_HISTORY_DEFAULT;
		const lookupCandidates = getAgentLookupCandidates(agentId);
		const agent =
			lookupCandidates
				.map(candidate => this.agents.get(candidate) ?? this.getByTasksAgentId(candidate))
				.find((candidate): candidate is AgentInfo => Boolean(candidate)) ?? null;
		let messages: unknown[] = [];
		if (agent) {
			const rpc = agent.rpc;
			if (rpc && rpc instanceof OmsRpcClient) {
				try {
					const all = await rpc.getMessages();
					messages = Array.isArray(all) ? all.slice(-max) : [];
				} catch (err) {
					logger.debug(
						"agents/registry.ts: best-effort failure after messages = Array.isArray(all) ? all.slice(-max) : [];",
						{ err },
					);
				}
			}
			if (messages.length === 0 && typeof this.tasksClient.readAgentMessages === "function") {
				try {
					const persisted = await this.tasksClient.readAgentMessages(agent.tasksAgentId || agent.id, max);
					if (Array.isArray(persisted)) messages = persisted.slice(-max);
				} catch (err) {
					logger.debug(
						"agents/registry.ts: best-effort failure after if (Array.isArray(persisted)) messages = persisted.slice(-max);",
						{ err },
					);
				}
			}
		} else if (typeof this.tasksClient.readAgentMessages === "function") {
			for (const candidate of lookupCandidates) {
				try {
					const persisted = await this.tasksClient.readAgentMessages(candidate, max);
					if (Array.isArray(persisted) && persisted.length > 0) {
						messages = persisted.slice(-max);
						break;
					}
				} catch (err) {
					logger.debug("agents/registry.ts: best-effort failure after break;", { err });
				}
			}
		}
		const toolCalls = extractToolCalls(messages).slice(-max);
		return {
			agent: agent
				? {
						id: agent.id,
						agentType: agent.agentType,
						taskId: agent.taskId,
						status: agent.status,
					}
				: null,
			messages,
			toolCalls,
		};
	}

	/** Append an event and update lastActivity. */
	pushEvent(id: string, event: AgentEvent, opts?: { maxEvents?: number }): void {
		const agent = this.agents.get(id);
		if (!agent) return;
		this._generation++;

		agent.events.push(event);
		const ts = typeof event.ts === "number" ? event.ts : Date.now();
		agent.lastActivity = Math.max(agent.lastActivity, ts);

		const maxEvents = opts?.maxEvents ?? this.eventLimit;
		if (agent.events.length > maxEvents) {
			agent.events.splice(0, agent.events.length - maxEvents);
		}

		for (const listener of this.eventListeners) {
			try {
				listener(id, event);
			} catch (err) {
				logger.debug("agents/registry.ts: best-effort failure after listener(id, event);", { err });
			}
		}
	}

	startHeartbeat(): void {
		if (this.heartbeatTimer) return;

		// Run one tick quickly (but async-safe) to establish presence.
		this.scheduleHeartbeatTick();

		this.heartbeatTimer = setInterval(() => {
			this.scheduleHeartbeatTick();
		}, this.intervalMs);
	}

	async stopHeartbeat(): Promise<void> {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.heartbeatInFlight) {
			await this.heartbeatInFlight;
		}
	}

	private scheduleHeartbeatTick(): void {
		if (this.heartbeatInFlight) return; // no overlap

		this.heartbeatInFlight = this.runHeartbeatTick().finally(() => {
			this.heartbeatInFlight = null;
		});
	}

	private async runHeartbeatTick(): Promise<void> {
		const now = Date.now();
		const activeAgents = this.getActive();

		// Heartbeat is best-effort; we don't want the loop to die on one failure.
		await Promise.all(
			activeAgents
				.filter(a => a.tasksAgentId?.trim())
				.map(async agent => {
					try {
						await this.tasksClient.heartbeat(agent.tasksAgentId);
						const current = this.agents.get(agent.id);
						if (current) current.lastActivity = Math.max(current.lastActivity, now);
					} catch {
						// Ignore; higher-level code may mark agent as stuck/dead.
					}
				}),
		);
	}
}
