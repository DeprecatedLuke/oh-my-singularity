import type { AgentRegistry } from "../agents/registry";
import { OmsRpcClient } from "../agents/rpc-wrapper";
import type { AgentSpawner } from "../agents/spawner";
import type { AgentInfo } from "../agents/types";
import { asRecord, logger } from "../utils";

type LogLevel = "debug" | "info" | "warn" | "error";

type ComplaintFrozenAgent = {
	agentId: string;
	taskId: string | null;
};

type ComplaintRecord = {
	id: string;
	createdAt: number;
	complainantAgentId: string;
	complainantTaskId: string;
	files: string[];
	reason: string;
	frozenAgents: ComplaintFrozenAgent[];
	resolverAgentId?: string;
	targetAgentId?: string;
	resolverStatus?: "resolved" | "unidentified" | "error" | "circular_loser";
	resolverReason?: string;
};

type ResolverDecision = {
	status: "resolved" | "unidentified";
	conflictingAgentId: string | null;
	conflictingTaskId: string | null;
	interruptSent: boolean;
	reason: string;
};

function isTerminalStatus(status: string | undefined): boolean {
	return status === "done" || status === "aborted" || status === "stopped" || status === "dead";
}

function normalizeComplaintFiles(files: string[]): string[] {
	const unique = new Set<string>();
	for (const file of files) {
		if (typeof file !== "string") continue;
		const normalized = file.trim().replace(/^\.\//, "");
		if (!normalized) continue;
		unique.add(normalized);
	}
	return [...unique];
}

function complaintFilesOverlap(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return false;
	const setA = new Set(a);
	for (const file of b) {
		if (setA.has(file)) return true;
	}
	return false;
}

export class ComplaintManager {
	private readonly complaints = new Map<string, ComplaintRecord>();
	private complaintSeq = 0;
	private readonly registry: AgentRegistry;
	private readonly spawner: AgentSpawner;
	private readonly loopLog: (msg: string, level: LogLevel, data?: unknown) => void;
	private readonly onDirty?: () => void;
	private readonly attachRpcHandlers: (agent: AgentInfo) => void;
	private readonly finishAgent: (agent: AgentInfo, status: "done" | "stopped" | "dead") => Promise<void>;
	private readonly logAgentStart: (startedBy: string, agent: AgentInfo, ctx?: string) => void;
	private readonly logAgentFinished: (agent: AgentInfo, text?: string) => Promise<void>;
	private readonly steerAgent: (taskId: string, message: string) => Promise<boolean>;

	constructor(opts: {
		registry: AgentRegistry;
		spawner: AgentSpawner;
		loopLog: (msg: string, level: LogLevel, data?: unknown) => void;
		onDirty?: () => void;
		attachRpcHandlers: (agent: AgentInfo) => void;
		finishAgent: (agent: AgentInfo, status: "done" | "stopped" | "dead") => Promise<void>;
		logAgentStart: (startedBy: string, agent: AgentInfo, ctx?: string) => void;
		logAgentFinished: (agent: AgentInfo, text?: string) => Promise<void>;
		steerAgent: (taskId: string, message: string) => Promise<boolean>;
	}) {
		this.registry = opts.registry;
		this.spawner = opts.spawner;
		this.loopLog = opts.loopLog;
		this.onDirty = opts.onDirty;
		this.onDirty = opts.onDirty;
		this.attachRpcHandlers = opts.attachRpcHandlers;
		this.finishAgent = opts.finishAgent;
		this.logAgentStart = opts.logAgentStart;
		this.logAgentFinished = opts.logAgentFinished;
		this.steerAgent = opts.steerAgent;
	}

	private resolveComplainantAgent(opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
	}): AgentInfo | null {
		const complainantAgentId = opts.complainantAgentId?.trim() ?? "";
		if (complainantAgentId) {
			const byId = this.registry.get(complainantAgentId);
			if (byId) return byId;
		}

		const complainantTaskId = opts.complainantTaskId?.trim() ?? "";
		if (!complainantTaskId) return null;

		const candidates = this.registry
			.getActiveByTask(complainantTaskId)
			.filter(agent => agent.role === "worker" || agent.role === "designer-worker");
		if (candidates.length === 0) return null;
		return candidates[0] ?? null;
	}

	private createComplaintId(complainantAgentId: string): string {
		this.complaintSeq += 1;
		return `${complainantAgentId}:complaint:${Date.now().toString(36)}:${this.complaintSeq.toString(36)}`;
	}

	private parseResolverDecision(text: string | null): ResolverDecision {
		if (!text?.trim()) {
			return {
				status: "unidentified",
				conflictingAgentId: null,
				conflictingTaskId: null,
				interruptSent: false,
				reason: "resolver returned no output",
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return {
				status: "unidentified",
				conflictingAgentId: null,
				conflictingTaskId: null,
				interruptSent: false,
				reason: "resolver output was not valid JSON",
			};
		}

		const rec = asRecord(parsed);
		const status = rec?.status === "resolved" ? "resolved" : "unidentified";
		const conflictingAgentId =
			typeof rec?.conflictingAgentId === "string" && rec.conflictingAgentId.trim()
				? rec.conflictingAgentId.trim()
				: null;
		const conflictingTaskId =
			typeof rec?.conflictingTaskId === "string" && rec.conflictingTaskId.trim()
				? rec.conflictingTaskId.trim()
				: null;
		const interruptSent = rec?.interruptSent === true;
		const reason =
			typeof rec?.reason === "string" && rec.reason.trim() ? rec.reason.trim() : "resolver returned no reason";

		return {
			status,
			conflictingAgentId,
			conflictingTaskId,
			interruptSent,
			reason,
		};
	}

	private async runComplaintResolver(complaint: ComplaintRecord): Promise<ResolverDecision> {
		let resolver: AgentInfo;
		try {
			resolver = await this.spawner.spawnResolver({
				complaintId: complaint.id,
				complainantAgentId: complaint.complainantAgentId,
				complainantTaskId: complaint.complainantTaskId,
				files: complaint.files,
				reason: complaint.reason,
				activeAgents: this.registry.listActiveSummaries(),
			});
			complaint.resolverAgentId = resolver.id;
			this.attachRpcHandlers(resolver);
			this.logAgentStart(complaint.complainantAgentId, resolver, `resolve complaint ${complaint.id}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			complaint.resolverStatus = "error";
			complaint.resolverReason = message;
			return {
				status: "unidentified",
				conflictingAgentId: null,
				conflictingTaskId: null,
				interruptSent: false,
				reason: `failed to spawn resolver: ${message}`,
			};
		}

		const resolverRpc = resolver.rpc;
		if (!resolverRpc || !(resolverRpc instanceof OmsRpcClient)) {
			await this.finishAgent(resolver, "dead");
			complaint.resolverStatus = "error";
			complaint.resolverReason = "resolver has no rpc";
			return {
				status: "unidentified",
				conflictingAgentId: null,
				conflictingTaskId: null,
				interruptSent: false,
				reason: "resolver has no rpc",
			};
		}

		try {
			await resolverRpc.waitForAgentEnd(120_000);
		} catch {
			await this.finishAgent(resolver, "dead");
			complaint.resolverStatus = "error";
			complaint.resolverReason = "resolver timed out";
			return {
				status: "unidentified",
				conflictingAgentId: null,
				conflictingTaskId: null,
				interruptSent: false,
				reason: "resolver timed out",
			};
		}

		let text: string | null = null;
		try {
			text = await resolverRpc.getLastAssistantText();
		} catch {
			text = null;
		}

		await this.finishAgent(resolver, "done");
		await this.logAgentFinished(resolver, text ?? "");
		return this.parseResolverDecision(text);
	}

	private findCounterComplaint(current: ComplaintRecord, targetAgentId: string): ComplaintRecord | null {
		for (const complaint of this.complaints.values()) {
			if (complaint.id === current.id) continue;
			if (complaint.complainantAgentId !== targetAgentId) continue;
			if (complaint.targetAgentId && complaint.targetAgentId !== current.complainantAgentId) continue;
			if (!complaintFilesOverlap(complaint.files, current.files)) continue;
			if (complaint.createdAt > current.createdAt) continue;
			return complaint;
		}

		return null;
	}

	private async applyResolverDecision(
		complaint: ComplaintRecord,
		decision: ResolverDecision,
	): Promise<ResolverDecision> {
		if (decision.status !== "resolved" || !decision.conflictingAgentId) {
			complaint.resolverStatus = "unidentified";
			complaint.resolverReason = decision.reason;
			return decision;
		}

		const conflictingAgent = this.registry.get(decision.conflictingAgentId);
		if (!conflictingAgent) {
			complaint.resolverStatus = "unidentified";
			complaint.resolverReason = `conflicting agent not found: ${decision.conflictingAgentId}`;
			return {
				...decision,
				status: "unidentified",
				interruptSent: false,
				reason: complaint.resolverReason,
			};
		}

		if (conflictingAgent.id === complaint.complainantAgentId) {
			complaint.resolverStatus = "unidentified";
			complaint.resolverReason = "resolver pointed to complainant itself";
			return {
				...decision,
				status: "unidentified",
				interruptSent: false,
				reason: complaint.resolverReason,
			};
		}

		const circularWinner = this.findCounterComplaint(complaint, conflictingAgent.id);
		if (circularWinner) {
			complaint.targetAgentId = conflictingAgent.id;
			complaint.resolverStatus = "circular_loser";
			complaint.resolverReason = `circular complaint detected; first complaint (${circularWinner.id}) wins`;
			return {
				...decision,
				status: "unidentified",
				interruptSent: false,
				reason: complaint.resolverReason,
			};
		}

		const freezeTaskId = decision.conflictingTaskId ?? conflictingAgent.taskId;
		if (!freezeTaskId) {
			complaint.resolverStatus = "unidentified";
			complaint.resolverReason = "resolver identified agent without task id";
			return {
				...decision,
				status: "unidentified",
				interruptSent: false,
				reason: complaint.resolverReason,
			};
		}

		let interruptSent = decision.interruptSent;
		if (!interruptSent) {
			const freezeMessage =
				`Conflict lock (${complaint.id}): agent ${complaint.complainantAgentId} is actively editing ` +
				`${complaint.files.join(", ")}. Pause edits on those files and wait until revoke_complaint is sent.`;
			interruptSent = await this.steerAgent(freezeTaskId, freezeMessage);
		}

		const frozenTargets = this.registry
			.getActive()
			.filter(agent => agent.taskId === freezeTaskId && agent.role !== "finisher")
			.map(agent => ({ agentId: agent.id, taskId: freezeTaskId }));
		if (frozenTargets.length === 0) {
			frozenTargets.push({ agentId: conflictingAgent.id, taskId: freezeTaskId });
		}

		for (const frozen of frozenTargets) {
			if (complaint.frozenAgents.some(existing => existing.agentId === frozen.agentId)) continue;
			complaint.frozenAgents.push(frozen);
		}

		complaint.targetAgentId = conflictingAgent.id;
		complaint.resolverStatus = "resolved";
		complaint.resolverReason = decision.reason;
		return {
			...decision,
			conflictingAgentId: conflictingAgent.id,
			conflictingTaskId: freezeTaskId,
			interruptSent,
		};
	}

	async complain(opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
		files: string[];
		reason: string;
	}): Promise<Record<string, unknown>> {
		const files = normalizeComplaintFiles(opts.files);
		const reason = opts.reason.trim();
		if (files.length === 0) {
			return { ok: false, summary: "complain rejected: files must be non-empty" };
		}
		if (!reason) {
			return { ok: false, summary: "complain rejected: reason is required" };
		}

		const complainant = this.resolveComplainantAgent({
			complainantAgentId: opts.complainantAgentId,
			complainantTaskId: opts.complainantTaskId,
		});
		if (!complainant) {
			return {
				ok: false,
				summary: "complain rejected: complainant agent not found in active registry",
			};
		}

		const complainantTaskId = complainant.taskId ?? opts.complainantTaskId?.trim() ?? "";
		if (!complainantTaskId) {
			return {
				ok: false,
				summary: "complain rejected: complainant task id is missing",
			};
		}

		const complaint: ComplaintRecord = {
			id: this.createComplaintId(complainant.id),
			createdAt: Date.now(),
			complainantAgentId: complainant.id,
			complainantTaskId,
			files,
			reason,
			frozenAgents: [],
		};
		this.complaints.set(complaint.id, complaint);

		this.loopLog(`Complaint registered: ${complaint.id}`, "info", {
			complaintId: complaint.id,
			complainantAgentId: complaint.complainantAgentId,
			complainantTaskId: complaint.complainantTaskId,
			files: complaint.files,
			reason: complaint.reason,
		});

		const resolverDecision = await this.runComplaintResolver(complaint);
		const finalDecision = await this.applyResolverDecision(complaint, resolverDecision);
		this.onDirty?.();

		const summary =
			complaint.resolverStatus === "resolved"
				? `Complaint ${complaint.id}: conflicting agent ${finalDecision.conflictingAgentId} asked to wait`
				: complaint.resolverStatus === "circular_loser"
					? `Complaint ${complaint.id}: circular conflict detected; existing complaint keeps priority`
					: `Complaint ${complaint.id}: resolver could not identify a conflicting agent`;

		return {
			ok: true,
			summary,
			complaintId: complaint.id,
			status: complaint.resolverStatus ?? "unidentified",
			complainantAgentId: complaint.complainantAgentId,
			complainantTaskId: complaint.complainantTaskId,
			files: complaint.files,
			resolverAgentId: complaint.resolverAgentId ?? null,
			conflictingAgentId: finalDecision.conflictingAgentId,
			conflictingTaskId: finalDecision.conflictingTaskId,
			interruptSent: finalDecision.interruptSent,
			reason: finalDecision.reason,
		};
	}

	private async notifyComplaintRelease(agentId: string, complaints: ComplaintRecord[]): Promise<void> {
		const target = this.registry.get(agentId);
		if (!target) return;
		if (isTerminalStatus(target.status)) return;

		const files = new Set<string>();
		for (const complaint of complaints) {
			for (const file of complaint.files) files.add(file);
		}

		const releaseMessage =
			`[CONFLICT LOCK RELEASED]\n\n` +
			`You may resume work. Released complaints: ${complaints.map(complaint => complaint.id).join(", ")}.` +
			(files.size > 0 ? ` Files: ${[...files].join(", ")}.` : "");

		const rpc = target.rpc;
		if (rpc && rpc instanceof OmsRpcClient) {
			try {
				await rpc.steer(releaseMessage);
			} catch (err) {
				logger.debug("loop/complaints.ts: best-effort failure after await rpc.steer(releaseMessage);", { err });
			}
		}

		this.registry.pushEvent(target.id, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `Complaint lock released (${complaints.map(complaint => complaint.id).join(", ")})`,
			data: {
				complaintIds: complaints.map(complaint => complaint.id),
			},
		});
	}

	async revokeComplaint(opts: {
		complainantAgentId?: string;
		complainantTaskId?: string;
		files?: string[];
		cause?: string;
	}): Promise<Record<string, unknown>> {
		const explicitComplainantId = opts.complainantAgentId?.trim() ?? "";
		const resolvedComplainant = this.resolveComplainantAgent({
			complainantAgentId: opts.complainantAgentId,
			complainantTaskId: opts.complainantTaskId,
		});
		const complainantId = explicitComplainantId || resolvedComplainant?.id || "";
		if (!complainantId) {
			return {
				ok: false,
				summary: "revoke_complaint rejected: complainant agent not found",
			};
		}

		const files = normalizeComplaintFiles(opts.files ?? []);
		const removed: ComplaintRecord[] = [];
		for (const complaint of this.complaints.values()) {
			if (complaint.complainantAgentId !== complainantId) continue;
			if (files.length > 0 && !complaintFilesOverlap(complaint.files, files)) continue;
			removed.push(complaint);
		}

		if (removed.length === 0) {
			return {
				ok: true,
				summary: "No active complaints matched revoke request",
				complainantAgentId: complainantId,
				revokedComplaintIds: [],
			};
		}

		for (const complaint of removed) {
			this.complaints.delete(complaint.id);
		}

		const removedIds = new Set(removed.map(complaint => complaint.id));
		const byFrozenAgent = new Map<string, ComplaintRecord[]>();
		for (const complaint of removed) {
			for (const frozen of complaint.frozenAgents) {
				const list = byFrozenAgent.get(frozen.agentId);
				if (list) {
					list.push(complaint);
				} else {
					byFrozenAgent.set(frozen.agentId, [complaint]);
				}
			}
		}

		const resumedAgents: string[] = [];
		for (const [frozenAgentId, sourceComplaints] of byFrozenAgent.entries()) {
			const stillFrozen = [...this.complaints.values()].some(complaint => {
				if (removedIds.has(complaint.id)) return false;
				return complaint.frozenAgents.some(frozen => frozen.agentId === frozenAgentId);
			});
			if (stillFrozen) continue;
			await this.notifyComplaintRelease(frozenAgentId, sourceComplaints);
			resumedAgents.push(frozenAgentId);
		}

		this.loopLog(`Complaints revoked for ${complainantId}`, "info", {
			complainantAgentId: complainantId,
			revokedComplaintIds: removed.map(complaint => complaint.id),
			resumedAgents,
			cause: opts.cause ?? null,
		});
		this.onDirty?.();

		return {
			ok: true,
			summary: `Revoked ${removed.length} complaint(s); resumed ${resumedAgents.length} agent(s)`,
			complainantAgentId: complainantId,
			revokedComplaintIds: removed.map(complaint => complaint.id),
			resumedAgents,
		};
	}
}
