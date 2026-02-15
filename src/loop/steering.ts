import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import type { OmsConfig } from "../config";
import { getCapabilities } from "../core/capabilities";
import { asRecord, logger } from "../utils";

type LogLevel = "debug" | "info" | "warn" | "error";

const STEERING_RECENT_ASSISTANT_TURNS = 5;

type SteeringToolCallSummary = {
	id: string | null;
	name: string;
	args: string;
	resultStatus: "pending" | "ok" | "error";
	result: string;
};

type SteeringTurnSummary = {
	assistant: string;
	tools: SteeringToolCallSummary[];
};

function isTerminalStatus(status: string | undefined): boolean {
	return status === "done" || status === "aborted" || status === "stopped" || status === "dead";
}

function normalizeSummary(text: string, max = 220): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	if (compact.length <= max) return compact;
	if (max <= 1) return "…";
	return `${compact.slice(0, max - 1)}…`;
}

function clipText(value: string, max: number): string {
	if (max <= 0) return "";
	if (value.length <= max) return value;
	if (max === 1) return "…";
	return `${value.slice(0, max - 1)}…`;
}

function squashWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function previewValue(value: unknown, max = 120): string {
	if (value === undefined) return "";
	let raw: string;
	if (typeof value === "string") {
		raw = value;
	} else {
		try {
			raw = JSON.stringify(value);
		} catch {
			raw = "[value]";
		}
	}
	return clipText(squashWhitespace(raw), max);
}

function collectTextFragments(value: unknown, depth = 0): string[] {
	if (depth > 3) return [];
	if (typeof value === "string") return [value];

	if (Array.isArray(value)) {
		const out: string[] = [];
		for (const item of value) out.push(...collectTextFragments(item, depth + 1));
		return out;
	}

	const rec = asRecord(value);
	if (!rec) return [];

	const out: string[] = [];
	if (typeof rec.text === "string") out.push(rec.text);
	if (typeof rec.content === "string") out.push(rec.content);
	if (Array.isArray(rec.content)) out.push(...collectTextFragments(rec.content, depth + 1));
	if (typeof rec.stdout === "string") out.push(rec.stdout);
	if (typeof rec.stderr === "string" && rec.stderr.trim()) out.push(`stderr: ${rec.stderr}`);
	if (typeof rec.error === "string" && rec.error.trim()) out.push(`error: ${rec.error}`);
	return out;
}

function hasToolError(value: unknown, depth = 0): boolean {
	if (depth > 3) return false;
	const rec = asRecord(value);
	if (!rec) return false;

	if (rec.is_error === true || rec.isError === true) return true;
	if (typeof rec.success === "boolean" && rec.success === false) return true;
	if (typeof rec.error === "string" && rec.error.trim()) return true;
	if (typeof rec.status === "string" && rec.status.toLowerCase() === "error") return true;
	if (typeof rec.exitCode === "number" && rec.exitCode !== 0) return true;
	if (typeof rec.exit_code === "number" && rec.exit_code !== 0) return true;

	const content = rec.content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (hasToolError(item, depth + 1)) return true;
		}
	} else if (content && typeof content === "object" && hasToolError(content, depth + 1)) {
		return true;
	}

	return false;
}

function formatToolArgsSummary(toolName: string, input: unknown): string {
	const rec = asRecord(input);
	if (!rec) return previewValue(input, 120);

	const base = toolName.replace(/^proxy_/, "");
	const pick = (keys: string[]): string => {
		const parts: string[] = [];
		for (const key of keys) {
			const value = rec[key];
			if (value === undefined || value === null) continue;
			const preview = previewValue(value, key === "command" ? 100 : 60);
			if (!preview) continue;
			parts.push(`${key}=${preview}`);
			if (parts.length >= 4) break;
		}
		return parts.join(" ");
	};

	if (base === "python") {
		const cells = Array.isArray(rec.cells) ? rec.cells.length : 0;
		return cells > 0 ? `cells=${cells}` : "(code)";
	}

	if (base === "task") {
		const tasks = Array.isArray(rec.tasks) ? rec.tasks.length : 0;
		return squashWhitespace([pick(["agent"]), tasks > 0 ? `tasks=${tasks}` : ""].filter(part => part).join(" "));
	}

	if (base === "edit") {
		const edits = Array.isArray(rec.edits) ? rec.edits.length : 0;
		return squashWhitespace([pick(["path"]), edits > 0 ? `edits=${edits}` : ""].filter(part => part).join(" "));
	}

	switch (base) {
		case "read":
			return pick(["path", "offset", "limit"]);
		case "grep":
			return pick(["pattern", "path", "glob", "type"]);
		case "find":
			return pick(["pattern", "hidden", "limit"]);
		case "bash":
			return pick(["command", "cwd"]);
		case "write":
			return pick(["path"]);
		case "lsp":
			return pick(["action", "file", "query", "line"]);
		case "fetch":
			return pick(["url"]);
		case "web_search":
			return pick(["query", "provider", "recency"]);
		case "tasks":
			return pick(["action", "id", "query", "status", "type"]);
		default:
			return previewValue(input, 120);
	}
}

function formatToolResultSummary(value: unknown): string {
	const lines = collectTextFragments(value)
		.map(line => line.replace(/\r/g, ""))
		.flatMap(line => line.split(/\n/))
		.map(line => squashWhitespace(line))
		.filter(line => line.length > 0);

	if (lines.length === 0) return previewValue(value, 220);

	const maxLines = 3;
	const capped = lines.slice(0, maxLines).map(line => clipText(line, 140));
	if (lines.length > maxLines) capped.push(`… +${lines.length - maxLines} lines`);
	return clipText(capped.join(" | "), 260);
}

function formatRecentMessagesForSteering(messages: unknown[]): string {
	if (!Array.isArray(messages) || messages.length === 0) return "";

	const turns: SteeringTurnSummary[] = [];
	const callById = new Map<string, SteeringToolCallSummary>();

	for (const message of messages) {
		const rec = asRecord(message);
		if (!rec) continue;

		const role = typeof rec.role === "string" ? rec.role : "";
		if (role === "assistant") {
			const content = Array.isArray(rec.content) ? rec.content : [rec.content];
			const textParts: string[] = [];
			const tools: SteeringToolCallSummary[] = [];

			for (const block of content) {
				const b = asRecord(block);
				if (!b) {
					if (typeof block === "string") textParts.push(block);
					continue;
				}

				const type = typeof b.type === "string" ? b.type : "";
				if (type === "tool_use") {
					const name = typeof b.name === "string" ? b.name : "?";
					const id = typeof b.id === "string" ? b.id : null;
					const input = b.input ?? b.arguments;
					const call: SteeringToolCallSummary = {
						id,
						name,
						args: formatToolArgsSummary(name, input),
						resultStatus: "pending",
						result: "(pending)",
					};
					tools.push(call);
					if (id) callById.set(id, call);
					continue;
				}

				if (typeof b.text === "string") {
					textParts.push(b.text);
					continue;
				}

				const fallback = collectTextFragments(block).join("\n");
				if (fallback) textParts.push(fallback);
			}

			const assistant = normalizeSummary(textParts.join("\n"), 260);
			if (!assistant && tools.length === 0) continue;
			turns.push({ assistant: assistant || "(no assistant text)", tools });
			continue;
		}

		if (role === "tool") {
			const toolUseId = typeof rec.tool_use_id === "string" ? rec.tool_use_id : null;
			if (!toolUseId) continue;

			const call = callById.get(toolUseId);
			if (!call) continue;

			const result = formatToolResultSummary(rec.content);
			const isError = hasToolError(rec) || /^error[:\s]/i.test(result);
			call.resultStatus = isError ? "error" : "ok";
			call.result = result || (isError ? "(error; no text)" : "(no output)");
		}
	}

	const recentTurns = turns.slice(-STEERING_RECENT_ASSISTANT_TURNS);
	if (recentTurns.length === 0) return "";

	const lines: string[] = [`Recent worker history (last ${recentTurns.length} assistant turns):`];

	for (let i = 0; i < recentTurns.length; i += 1) {
		const turn = recentTurns[i];
		if (!turn) continue;

		lines.push(`Turn ${i + 1}:`);
		lines.push(`assistant: ${turn.assistant}`);

		if (turn.tools.length === 0) {
			lines.push("tools: (none)");
			continue;
		}

		lines.push("tools:");
		for (const tool of turn.tools) {
			const args = tool.args ? ` ${tool.args}` : "";
			lines.push(`- ${tool.name}${args} -> ${tool.resultStatus}: ${clipText(tool.result || "(no output)", 260)}`);
		}
	}

	return clipText(lines.join("\n"), 5_000);
}

export class SteeringManager {
	private readonly steeringInFlightByWorker = new Map<string, Promise<void>>();
	private readonly lastSteeringAtByWorker = new Map<string, number>();
	private readonly finisherSpawningTasks = new Set<string>();
	private broadcastInFlight: Promise<void> | null = null;
	private readonly pendingInterruptKickoffByTask = new Map<string, string[]>();
	private readonly registry: AgentRegistry;
	private readonly spawner: AgentSpawner;
	private readonly config: OmsConfig;
	private readonly loopLog: (msg: string, level: LogLevel, data?: unknown) => void;
	private readonly onDirty?: () => void;
	private readonly attachRpcHandlers: (agent: AgentInfo) => void;
	private readonly finishAgent: (agent: AgentInfo, status: "done" | "stopped" | "dead") => Promise<void>;
	private readonly logAgentStart: (startedBy: string, agent: AgentInfo, ctx?: string) => void;
	private readonly logAgentFinished: (agent: AgentInfo, text?: string) => Promise<void>;
	private readonly stopAgentsMatching: (pred: (a: AgentInfo) => boolean) => Promise<Set<string>>;

	constructor(opts: {
		registry: AgentRegistry;
		spawner: AgentSpawner;
		config: OmsConfig;
		loopLog: (msg: string, level: LogLevel, data?: unknown) => void;
		onDirty?: () => void;
		attachRpcHandlers: (agent: AgentInfo) => void;
		finishAgent: (agent: AgentInfo, status: "done" | "stopped" | "dead") => Promise<void>;
		logAgentStart: (startedBy: string, agent: AgentInfo, ctx?: string) => void;
		logAgentFinished: (agent: AgentInfo, text?: string) => Promise<void>;
		stopAgentsMatching: (pred: (a: AgentInfo) => boolean) => Promise<Set<string>>;
	}) {
		this.registry = opts.registry;
		this.spawner = opts.spawner;
		this.config = opts.config;
		this.loopLog = opts.loopLog;
		this.onDirty = opts.onDirty;
		this.attachRpcHandlers = opts.attachRpcHandlers;
		this.finishAgent = opts.finishAgent;
		this.logAgentStart = opts.logAgentStart;
		this.logAgentFinished = opts.logAgentFinished;
		this.stopAgentsMatching = opts.stopAgentsMatching;
	}

	getActiveWorkerAgents(): AgentInfo[] {
		return this.registry
			.getActive()
			.filter(a => getCapabilities(a.role).category === "implementer" && !isTerminalStatus(a.status));
	}

	hasFinisherTakeover(taskId: string): boolean {
		if (this.finisherSpawningTasks.has(taskId)) return true;
		return this.registry.getActiveByTask(taskId).some(agent => getCapabilities(agent.role).category === "verifier");
	}

	onAgentStopped(agentId: string): void {
		this.steeringInFlightByWorker.delete(agentId);
		this.lastSteeringAtByWorker.delete(agentId);
	}

	hasPendingInterruptKickoff(taskId: string): boolean {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		return (this.pendingInterruptKickoffByTask.get(normalizedTaskId)?.length ?? 0) > 0;
	}

	takePendingInterruptKickoff(taskId: string): string | null {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return null;
		const pending = this.pendingInterruptKickoffByTask.get(normalizedTaskId);
		if (!pending || pending.length === 0) return null;
		this.pendingInterruptKickoffByTask.delete(normalizedTaskId);
		return pending.join("\n\n");
	}

	async stopSteeringForFinisher(taskId: string): Promise<void> {
		const activeForTask = this.registry.getActiveByTask(taskId);
		const taskAgents = this.registry.getByTask(taskId);
		const workerIds = taskAgents
			.filter(agent => getCapabilities(agent.role).category === "implementer")
			.map(agent => agent.id);
		const inFlight = workerIds
			.map(workerId => this.steeringInFlightByWorker.get(workerId))
			.filter((promise): promise is Promise<void> => !!promise);
		for (const workerId of workerIds) {
			this.steeringInFlightByWorker.delete(workerId);
			this.lastSteeringAtByWorker.delete(workerId);
		}
		const steeringAgentIds = activeForTask
			.filter(agent => getCapabilities(agent.role).category === "supervisor")
			.map(agent => agent.id);
		const isTaskSteering = (agent: AgentInfo) =>
			agent.taskId === taskId && getCapabilities(agent.role).category === "supervisor";
		await this.stopAgentsMatching(isTaskSteering);

		if (inFlight.length > 0) {
			await Promise.race([Promise.allSettled(inFlight), Bun.sleep(1_000)]);
			await this.stopAgentsMatching(isTaskSteering);
		}

		if (steeringAgentIds.length > 0 || inFlight.length > 0) {
			this.loopLog(`Stopped steering agent(s) for finisher takeover on ${taskId}`, "info", {
				taskId,
				stopped: steeringAgentIds,
				inFlightWorkers: inFlight.length,
			});
		}
	}

	/**
	 * Generalized method to stop all supervisor agents for a task
	 * Used by WorkflowEngine.stopSupervisors()
	 */
	async stopSupervisors(taskId: string): Promise<void> {
		const activeForTask = this.registry.getActiveByTask(taskId);
		const taskAgents = this.registry.getByTask(taskId);
		const workerIds = taskAgents
			.filter(agent => getCapabilities(agent.role).category === "implementer")
			.map(agent => agent.id);
		const inFlight = workerIds
			.map(workerId => this.steeringInFlightByWorker.get(workerId))
			.filter((promise): promise is Promise<void> => !!promise);
		for (const workerId of workerIds) {
			this.steeringInFlightByWorker.delete(workerId);
			this.lastSteeringAtByWorker.delete(workerId);
		}
		const steeringAgentIds = activeForTask
			.filter(agent => getCapabilities(agent.role).category === "supervisor")
			.map(agent => agent.id);
		const isTaskSteering = (agent: AgentInfo) =>
			agent.taskId === taskId && getCapabilities(agent.role).category === "supervisor";
		await this.stopAgentsMatching(isTaskSteering);

		if (inFlight.length > 0) {
			await Promise.race([Promise.allSettled(inFlight), Bun.sleep(1_000)]);
			await this.stopAgentsMatching(isTaskSteering);
		}

		if (steeringAgentIds.length > 0 || inFlight.length > 0) {
			this.loopLog(`Stopped supervisor agent(s) for task ${taskId}`, "info", {
				taskId,
				stopped: steeringAgentIds,
				inFlightWorkers: inFlight.length,
			});
		}
	}

	async spawnFinisherAfterStoppingSteering(taskId: string, workerOutput: string): Promise<AgentInfo> {
		this.finisherSpawningTasks.add(taskId);
		try {
			await this.stopSteeringForFinisher(taskId);
			return await this.spawner.spawnFinisher(taskId, workerOutput);
		} finally {
			this.finisherSpawningTasks.delete(taskId);
		}
	}

	async steerAgent(taskId: string, message: string): Promise<boolean> {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		const trimmed = message.trim();
		if (!trimmed) return false;
		const steerSummary = `${normalizeSummary(trimmed)}\n`;
		const targets = this.registry
			.getActive()
			.filter(agent => agent.taskId === normalizedTaskId && getCapabilities(agent.role).category !== "verifier");
		if (targets.length === 0) {
			this.loopLog(`Steer: no active agents for task ${normalizedTaskId}`, "warn", {
				taskId: normalizedTaskId,
			});
			return false;
		}

		await Promise.all(
			targets.map(async agent => {
				const rpc = agent.rpc;
				if (rpc && rpc instanceof OmsRpcClient) {
					try {
						await rpc.steer(trimmed);
					} catch {
						this.loopLog(`Steer: failed to deliver message to ${agent.id}`, "warn", {
							taskId: normalizedTaskId,
							agentId: agent.id,
						});
					}
				}
				this.registry.pushEvent(agent.id, {
					type: "log",
					ts: Date.now(),
					level: "info",
					message: steerSummary ? `Steer from singularity: ${steerSummary}` : "Steer from singularity",
					data: { taskId: normalizedTaskId, message: trimmed },
				});
			}),
		);

		this.loopLog(`Steer: delivered message for task ${normalizedTaskId}`, "info", {
			taskId: normalizedTaskId,
			agentIds: targets.map(agent => agent.id),
			steerSummary,
		});
		this.onDirty?.();
		return true;
	}

	private queuePendingInterruptKickoff(taskId: string, kickoffMessage: string): void {
		const existing = this.pendingInterruptKickoffByTask.get(taskId) ?? [];
		existing.push(kickoffMessage);
		this.pendingInterruptKickoffByTask.set(taskId, existing);
	}

	private async stopAgentGracefully(agent: AgentInfo, taskId: string): Promise<void> {
		const current = this.registry.get(agent.id);
		if (current) current.status = "stopped";
		const rpc = agent.rpc;
		if (rpc && rpc instanceof OmsRpcClient) {
			let isStreaming = false;
			try {
				const state = await rpc.getState();
				const stateRec = asRecord(state);
				isStreaming = stateRec?.isStreaming === true;
			} catch (err) {
				logger.debug("loop/steering.ts: best-effort failure after await rpc.getState();", { err });
			}

			try {
				await rpc.abort();
			} catch (err) {
				this.loopLog(`Interrupt: failed to abort ${agent.id}`, "warn", {
					taskId,
					agentId: agent.id,
					error: err instanceof Error ? err.message : String(err),
				});
			}

			if (isStreaming) {
				const pollIntervalMs = 500;
				const timeoutMs = 10_000;
				const startedAt = Date.now();

				while (Date.now() - startedAt < timeoutMs) {
					try {
						const state = await rpc.getState();
						const stateRec = asRecord(state);
						if (stateRec?.isStreaming !== true) break;
					} catch {
						// Ignore state-check failures while waiting for graceful stop.
					}

					await Bun.sleep(pollIntervalMs);
				}
			}
		}
		await this.finishAgent(agent, "stopped");
		this.onAgentStopped(agent.id);
	}
	async interruptAgent(taskId: string, message: string): Promise<boolean> {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) return false;
		const trimmed = message.trim();
	const interruptMessage = trimmed ? `[URGENT MESSAGE]\n\n${trimmed}` : "[URGENT MESSAGE]";
	const interruptSummary = `${normalizeSummary(trimmed || interruptMessage)}\n`;
	const targets = this.registry
		.getActive()
		.filter(agent => agent.taskId === normalizedTaskId && getCapabilities(agent.role).category !== "verifier");
		if (targets.length === 0) {
			this.queuePendingInterruptKickoff(normalizedTaskId, interruptMessage);
			this.loopLog(
				`Interrupt: queued restart kickoff for task ${normalizedTaskId} (no active agents to stop)`,
				"warn",
				{
					taskId: normalizedTaskId,
					interruptSummary,
				},
			);
			this.onDirty?.();
			return true;
		}
		await Promise.all(
			targets.map(async agent => {
				this.registry.pushEvent(agent.id, {
					type: "log",
					ts: Date.now(),
					level: "warn",
					message: interruptSummary
						? `Interrupt from singularity: ${interruptSummary}`
						: "Interrupt from singularity",
					data: { taskId: normalizedTaskId, message: trimmed, graceful: true },
				});
				const rpc = agent.rpc;
				if (rpc && rpc instanceof OmsRpcClient) {
					try {
						rpc.suppressNextAgentEnd();
						await rpc.abortAndPrompt(interruptMessage);
					} catch (err) {
						this.loopLog(`Interrupt: abortAndPrompt failed for ${agent.id}, cleaning up`, "warn", {
							taskId: normalizedTaskId,
							agentId: agent.id,
							error: err instanceof Error ? err.message : String(err),
						});
						await this.finishAgent(agent, "stopped");
						this.onAgentStopped(agent.id);
						this.queuePendingInterruptKickoff(normalizedTaskId, interruptMessage);
					}
				} else {
					await this.stopAgentGracefully(agent, normalizedTaskId);
					this.queuePendingInterruptKickoff(normalizedTaskId, interruptMessage);
				}
			}),
		);
		this.loopLog(`Interrupt: abort+prompt delivered for task ${normalizedTaskId}`, "warn", {
			taskId: normalizedTaskId,
			agentIds: targets.map(agent => agent.id),
			interruptSummary,
		});
		this.onDirty?.();
		return true;
	}

	async broadcastToWorkers(message: string, meta?: unknown): Promise<void> {
		const trimmed = message.trim();
		if (!trimmed) return;

		if (this.broadcastInFlight) return;

		const p = this.runBroadcastToWorkers(trimmed, meta).finally(() => {
			this.broadcastInFlight = null;
		});

		this.broadcastInFlight = p;
		await p;
	}

	private async runBroadcastToWorkers(message: string, meta?: unknown): Promise<void> {
		const workers = this.getActiveWorkerAgents().filter(w => !!w.taskId);
		if (workers.length === 0) return;

		const urgency = (() => {
			const rec = asRecord(meta);
			const u = rec && typeof rec.urgency === "string" ? rec.urgency : null;
			return u === "critical" || u === "normal" ? u : undefined;
		})();

		const summary = workers.map(w => ({
			id: w.id,
			taskId: w.taskId,
			status: w.status,
			lastActivity: w.lastActivity,
		}));

		let steering: AgentInfo;
		try {
			steering = await this.spawner.spawnBroadcastSteering({
				message,
				urgency,
				workers: summary,
			});
			this.attachRpcHandlers(steering);
			this.logAgentStart("OMS/system", steering, message);
		} catch {
			return;
		}

		const steeringRpc = steering.rpc;
		if (!steeringRpc || !(steeringRpc instanceof OmsRpcClient)) {
			await this.finishAgent(steering, "dead");
			return;
		}

		try {
			await steeringRpc.waitForAgentEnd(60_000);
		} catch {
			await this.finishAgent(steering, "dead");
			return;
		}

		let text: string | null = null;
		try {
			text = await steeringRpc.getLastAssistantText();
		} catch {
			text = null;
		}

		if (!text) {
			await this.finishAgent(steering, "done");
			await this.logAgentFinished(steering, "");
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			await this.finishAgent(steering, "done");
			await this.logAgentFinished(steering, text);
			return;
		}

		const rec = asRecord(parsed);
		const decisions = rec && Array.isArray(rec.decisions) ? rec.decisions : [];

		for (const d of decisions) {
			const dr = asRecord(d);
			if (!dr) continue;

			const taskId = typeof dr.taskId === "string" ? dr.taskId : null;
			const action = typeof dr.action === "string" ? dr.action : null;
			const msg = typeof dr.message === "string" ? dr.message : null;
			const reason = typeof dr.reason === "string" ? dr.reason : null;

			if (!taskId || !action) continue;

			const worker = workers.find(w => w.taskId === taskId);
			if (!worker) continue;
			if (this.hasFinisherTakeover(taskId)) continue;

			const workerRpc = worker.rpc;
			if (!workerRpc || !(workerRpc instanceof OmsRpcClient)) continue;

			if (action === "steer") {
				const finalMsg = msg?.trim() ? msg.trim() : message;
				try {
					await workerRpc.steer(finalMsg);
				} catch (err) {
					logger.debug("loop/steering.ts: best-effort failure after await workerRpc.steer(finalMsg);", { err });
				}

				this.registry.pushEvent(worker.id, {
					type: "log",
					ts: Date.now(),
					level: "info",
					message: `Broadcast steer${reason ? `: ${reason}` : ""}`,
					data: { taskId, reason },
				});
			} else if (action === "interrupt") {
				try {
					await workerRpc.abort();
				} catch (err) {
					logger.debug("loop/steering.ts: best-effort failure after await workerRpc.abort();", { err });
				}

				this.registry.pushEvent(worker.id, {
					type: "log",
					ts: Date.now(),
					level: "warn",
					message: `Broadcast interrupt${reason ? `: ${reason}` : ""}`,
					data: { taskId, reason },
				});
			}
		}

		await this.finishAgent(steering, "done");
		await this.logAgentFinished(steering, text);
		this.onDirty?.();
	}

	async maybeSteerWorkers(paused: boolean): Promise<void> {
		if (paused) return;
		const now = Date.now();
		const interval = this.config.steeringIntervalMs;

		for (const worker of this.getActiveWorkerAgents()) {
			if (!worker.taskId) continue;
			if (isTerminalStatus(worker.status)) continue;
			if (this.hasFinisherTakeover(worker.taskId)) continue;

			const last = this.lastSteeringAtByWorker.get(worker.id) ?? worker.spawnedAt;
			if (now - last < interval) continue;
			if (this.steeringInFlightByWorker.has(worker.id)) continue;

			const p = this.runSteeringForWorker(worker)
				.catch(err => {
					this.loopLog(`Steering task failed for ${worker.id}`, "warn", {
						taskId: worker.taskId ?? null,
						agentId: worker.id,
						error: err instanceof Error ? err.message : String(err),
					});
				})
				.finally(() => {
					this.steeringInFlightByWorker.delete(worker.id);
				});

			this.steeringInFlightByWorker.set(worker.id, p);
			this.lastSteeringAtByWorker.set(worker.id, now);
		}
	}

	private async runSteeringForWorker(worker: AgentInfo): Promise<void> {
		const rpc = worker.rpc;
		if (!rpc || !(rpc instanceof OmsRpcClient)) return;

		const taskId = worker.taskId?.trim();
		if (!taskId) return;
		if (this.hasFinisherTakeover(taskId)) return;

		let recent = "";
		try {
			const messages = await rpc.getMessages();
			recent = formatRecentMessagesForSteering(messages);
			if (!recent.trim()) {
				recent = (await rpc.getLastAssistantText()) ?? "";
			}
		} catch {
			try {
				recent = (await rpc.getLastAssistantText()) ?? "";
			} catch {
				recent = "";
			}
		}

		let steering: AgentInfo;
		try {
			steering = await this.spawner.spawnSteering(taskId, recent);
			this.attachRpcHandlers(steering);
			this.logAgentStart(worker.id, steering, recent);
		} catch {
			return;
		}

		if (this.hasFinisherTakeover(taskId)) {
			await this.finishAgent(steering, "stopped");
			return;
		}

		const steeringRpc = steering.rpc;
		if (!steeringRpc || !(steeringRpc instanceof OmsRpcClient)) return;

		let currentAssistantText = "";
		const assistantTextParts: string[] = [];
		let firstAssistantText: string | null = null;
		let forceStoppedAfterFirstResponse = false;
		const unsubscribeSteeringEvents = steeringRpc.onEvent(event => {
			const rec = asRecord(event);
			if (!rec) return;
			const type = typeof rec.type === "string" ? rec.type : "";
			if (type === "message_update") {
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
				return;
			}
			if (type === "message_end" && !forceStoppedAfterFirstResponse) {
				const assembled = [...assistantTextParts, currentAssistantText].join("").trim();
				if (!assembled) return;
				firstAssistantText = assembled;
				forceStoppedAfterFirstResponse = true;
				try {
					steeringRpc.forceKill();
				} catch (err) {
					logger.debug("loop/steering.ts: best-effort failure after steeringRpc.forceKill();", { err });
				}
			}
		});
		let steeringWaitFailed = false;
		try {
			await steeringRpc.waitForAgentEnd(60_000);
		} catch {
			steeringWaitFailed = true;
		} finally {
			unsubscribeSteeringEvents();
		}
		let text: string | null = null;
		try {
			text = await steeringRpc.getLastAssistantText();
		} catch {
			text = null;
		}
		const streamedAssistantText = [...assistantTextParts, currentAssistantText].join("").trim();
		if ((!text || !text.trim()) && firstAssistantText) {
			text = firstAssistantText;
		}
		if ((!text || !text.trim()) && streamedAssistantText) {
			text = streamedAssistantText;
		}

		if (steeringWaitFailed) {
			try {
				steeringRpc.forceKill();
			} catch (err) {
				logger.debug("loop/steering.ts: best-effort failure after steeringRpc.forceKill();", { err });
			}
			if (!text || !text.trim()) {
				await this.finishAgent(steering, this.hasFinisherTakeover(taskId) ? "stopped" : "dead");
				return;
			}
		}

		if (!text || !text.trim()) {
			await this.finishAgent(steering, "done");
			await this.logAgentFinished(steering, "");
			return;
		}

		let decision: unknown;
		try {
			decision = JSON.parse(text);
		} catch {
			await this.finishAgent(steering, "done");
			await this.logAgentFinished(steering, text);
			return;
		}

		const d = asRecord(decision);
		const action = d && typeof d.action === "string" ? d.action : null;
		if (this.hasFinisherTakeover(taskId)) {
			await this.finishAgent(steering, "stopped");
			await this.logAgentFinished(steering, text);
			return;
		}
		const steeringState = this.registry.get(steering.id);
		if (!steeringState || isTerminalStatus(steeringState.status)) {
			return;
		}

		if (action === "steer") {
			const msg = d && typeof d.message === "string" ? d.message : null;
			if (msg) {
				try {
					await rpc.steer(msg);
				} catch (err) {
					logger.debug("loop/steering.ts: best-effort failure after await rpc.steer(msg);", { err });
				}
			}
		} else if (action === "interrupt") {
			try {
				await rpc.abort();
			} catch (err) {
				logger.debug("loop/steering.ts: best-effort failure after await rpc.abort();", { err });
			}
		}

		await this.finishAgent(steering, "done");
		await this.logAgentFinished(steering, text);
	}

	async runResumeSteering(taskId: string): Promise<{
		action: "start" | "skip" | "defer";
		message: string | null;
		reason: string | null;
	}> {
		const normalizeAction = (rawAction: unknown): "start" | "skip" | "defer" | null => {
			if (typeof rawAction !== "string") return null;
			const action = rawAction.trim().toLowerCase();
			if (action === "start" || action === "skip" || action === "defer") return action;
			// Backward-compatibility for any remaining steering-style output:
			if (action === "steer") return "start";
			if (action === "interrupt") return "defer";
			return null;
		};
		let issuer: AgentInfo;
		try {
			issuer = await this.spawner.spawnIssuer(
				taskId,
				"Task is already in_progress but has no active agent. " +
					"Decide whether to start, skip, or defer. Reply with one JSON object only: " +
					'{"action": "start"|"skip"|"defer", "message"?: string, "reason"?: string}.',
			);
			this.attachRpcHandlers(issuer);
			this.logAgentStart("OMS/system", issuer, "Resume in-progress task");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.loopLog(`Resume issuer spawn failed for ${taskId}: ${message}`, "warn", {
				taskId,
				error: message,
			});
			return { action: "defer", message: null, reason: "resume issuer spawn failed" };
		}
		const issuerRpc = issuer.rpc;
		if (!issuerRpc || !(issuerRpc instanceof OmsRpcClient)) {
			await this.finishAgent(issuer, "dead");
			return { action: "defer", message: null, reason: "resume issuer unavailable (no rpc)" };
		}

		try {
			await issuerRpc.waitForAgentEnd(20_000);
		} catch {
			await this.finishAgent(issuer, "dead");
			return { action: "defer", message: null, reason: "resume issuer timed out" };
		}
		let text: string | null = null;
		try {
			text = await issuerRpc.getLastAssistantText();
		} catch {
			text = null;
		}
		await this.finishAgent(issuer, "done");
		await this.logAgentFinished(issuer, text ?? "");
		if (!text) return { action: "defer", message: null, reason: "resume issuer produced no output" };
		let decision: unknown;
		try {
			decision = JSON.parse(text);
		} catch {
			return { action: "defer", message: null, reason: "resume issuer returned invalid JSON" };
		}
		const d = asRecord(decision);
		const action = normalizeAction(d && typeof d.action === "string" ? d.action : null);
		const message = d && typeof d.message === "string" ? d.message.trim() : "";
		const reason = d && typeof d.reason === "string" ? d.reason.trim() : "";
		if (action === "start") {
			return { action, message: message || null, reason: null };
		}
		if (action === "skip") {
			return { action, message: message || null, reason: reason || "Resume issuer requested skip" };
		}
		if (action === "defer") {
			return { action, message: message || null, reason: reason || "Resume issuer requested defer" };
		}

		return {
			action: "defer",
			message: null,
			reason: action
				? `resume issuer returned unsupported action '${action}'`
				: "resume issuer returned no actionable decision",
		};
	}
}
