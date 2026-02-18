import type { AgentRegistry } from "../agents/registry";
import type { AgentRole, AgentStatus } from "../agents/types";
import {
	INTERVAL_WAIT_SLEEP_MS,
	LIMIT_MESSAGE_HISTORY_DEFAULT,
	LIMIT_TASK_LIST_DEFAULT,
	TIMEOUT_AGENT_WAIT_MS,
	TIMEOUT_MIN_MS,
} from "../config/constants";
import type { AgentLoop } from "../loop/agent-loop";
import type {
	TaskCreateInput,
	TaskDepTreeInput,
	TaskSearchInput,
	TaskStoreClient,
	TaskUpdateInput,
} from "../tasks/client";
import { TaskCliError } from "../tasks/client";
import type { BatchCreateIssueInput } from "../tasks/store/types";
import type { TaskIssue } from "../tasks/types";
import { asRecord, logger } from "../utils";

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const normalized = asString(item);
		if (!normalized) continue;
		out.push(normalized);
	}
	return out;
}

function asFiniteInt(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.trunc(value);
}

type CompactTaskListIssue = {
	id: string;
	title: string;
	status: string;
	priority: number;
	assignee: string | null;
	dependency_count: number;
	issue_type: string;
};

function isClosedTaskIssue(issue: TaskIssue): boolean {
	return (
		String(issue.status ?? "")
			.trim()
			.toLowerCase() === "closed"
	);
}

function isTaskNotFoundError(err: unknown): boolean {
	const details = err instanceof TaskCliError ? [err.message, err.stdout, err.stderr].join(" ").toLowerCase() : "";
	return /(not found|does not exist|no such)/.test(details);
}

function getTaskDependencyCount(issue: TaskIssue): number {
	const rec = asRecord(issue);
	if (!rec) return 0;
	const dependsOnIds = rec.depends_on_ids;
	return Array.isArray(dependsOnIds) ? dependsOnIds.length : 0;
}

function toCompactTaskListIssue(issue: TaskIssue): CompactTaskListIssue {
	return {
		id: issue.id,
		title: issue.title,
		status: String(issue.status ?? ""),
		priority: typeof issue.priority === "number" && Number.isFinite(issue.priority) ? Math.trunc(issue.priority) : 0,
		assignee: typeof issue.assignee === "string" ? issue.assignee : null,
		dependency_count: getTaskDependencyCount(issue),
		issue_type: String(issue.issue_type ?? ""),
	};
}

function isTerminalAgentStatus(status: unknown): boolean {
	const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
	return (
		normalized === "done" ||
		normalized === "failed" ||
		normalized === "aborted" ||
		normalized === "stopped" ||
		normalized === "dead"
	);
}

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

function getIssueTaskBinding(issue: TaskIssue): string | null {
	const rec = asRecord(issue);
	if (!rec) return null;
	const hookTask = asString(rec.hook_task);
	if (hookTask) return hookTask;
	const slotBindings = asRecord(rec.slot_bindings);
	if (!slotBindings) return null;
	return asString(slotBindings.hook);
}

function inferAgentRoleFromIssue(issue: TaskIssue): AgentRole {
	const title = typeof issue.title === "string" ? issue.title.trim().toLowerCase() : "";
	if (title.startsWith("designer-worker-")) return "designer-worker";
	if (title.startsWith("worker-")) return "worker";
	if (title.startsWith("issuer-")) return "issuer";
	if (title.startsWith("finisher-")) return "finisher";
	if (title.startsWith("steering-") || title.startsWith("resolver-") || title.startsWith("broadcast-steering-")) {
		return "steering";
	}
	if (title.startsWith("singularity-")) return "singularity";
	return "worker";
}

function parseTimestampMs(value: unknown): number {
	if (typeof value !== "string") return 0;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : 0;
}

function resolveRegistryAgent(registry: AgentRegistry, agentId: string) {
	for (const candidate of getAgentLookupCandidates(agentId)) {
		const liveAgent = registry.get(candidate) ?? registry.getByTasksAgentId(candidate);
		if (liveAgent) return liveAgent;
	}
	return undefined;
}

async function resolveAgentTaskIdFromStore(tasksClient: TaskStoreClient, agentId: string): Promise<string | null> {
	for (const candidate of getAgentLookupCandidates(agentId)) {
		try {
			const issue = await tasksClient.show(candidate);
			if (String(issue.issue_type ?? "").toLowerCase() !== "agent") continue;
			const boundTaskId = getIssueTaskBinding(issue);
			if (boundTaskId) return boundTaskId;
		} catch (err) {
			logger.debug("ipc/handlers.ts: best-effort failure after if (boundTaskId) return boundTaskId;", { err });
		}
	}
	return null;
}

async function listPersistedTaskAgents(
	tasksClient: TaskStoreClient,
	taskId: string,
): Promise<
	Array<{
		id: string;
		tasksAgentId: string;
		role: AgentRole;
		state: AgentStatus;
		lastActivity: number;
		source: string;
	}>
> {
	const normalizedTaskId = taskId.trim();
	if (!normalizedTaskId) return [];
	let issues: TaskIssue[] = [];
	try {
		issues = await tasksClient.list(["--all", "--type", "agent"]);
	} catch {
		return [];
	}
	const agents = issues
		.filter(issue => getIssueTaskBinding(issue) === normalizedTaskId)
		.map(issue => {
			const rec = asRecord(issue) ?? {};
			const state = (asString(rec.agent_state) ?? asString(issue.status) ?? "unknown") as AgentStatus;
			const lastActivity =
				parseTimestampMs(rec.last_activity) ||
				parseTimestampMs(issue.updated_at) ||
				parseTimestampMs(issue.created_at);
			return {
				id: issue.id,
				tasksAgentId: issue.id,
				role: inferAgentRoleFromIssue(issue),
				state,
				lastActivity,
				source: "persisted",
			};
		});
	agents.sort((a, b) => b.lastActivity - a.lastActivity);
	return agents;
}

async function waitForRegistryAgentExit(
	registry: AgentRegistry,
	agentId: string,
	timeoutMs: number,
): Promise<{
	ok: boolean;
	timeout?: boolean;
	agentId: string;
	status?: string;
	error?: string;
}> {
	const start = Date.now();
	const timeout = Math.max(TIMEOUT_MIN_MS, timeoutMs);
	while (Date.now() - start < timeout) {
		const agent = registry.get(agentId);
		if (!agent) {
			return { ok: true, agentId, status: "not_found" };
		}
		if (isTerminalAgentStatus(agent.status)) {
			return { ok: true, agentId, status: String(agent.status) };
		}
		await Bun.sleep(INTERVAL_WAIT_SLEEP_MS);
	}
	return { ok: false, timeout: true, agentId, error: `Timed out waiting for ${agentId}` };
}

const TASKS_MUTATION_ACTIONS = new Set(["create", "update", "close", "comment_add", "delete"]);

function truncateForLog(value: string, max = 120): string {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	if (max <= 1) return "…";
	return `${compact.slice(0, max - 1)}…`;
}

function logTasksMutationForSystem(
	registry: AgentRegistry,
	systemAgentId: string,
	request: unknown,
	response: { ok: true; data: unknown } | { ok: false; error: string },
): void {
	const rec = asRecord(request);
	if (!rec) return;

	const action = asString(rec.action)?.toLowerCase();
	if (!action || !TASKS_MUTATION_ACTIONS.has(action)) return;

	const actor = asString(rec.actor) ?? "unknown";
	const params = asRecord(rec.params) ?? {};
	const responseData = response.ok ? asRecord(response.data) : null;
	const issueId = asString(params.id) ?? asString(rec.defaultTaskId) ?? asString(responseData?.id) ?? null;

	const data: Record<string, unknown> = {
		action,
		actor,
	};
	if (issueId) data.issueId = issueId;

	if (action === "create") {
		const title = asString(params.title);
		if (title) data.title = truncateForLog(title, 140);
		const issueType = asString(params.type);
		if (issueType) data.type = issueType;
	}

	if (action === "update") {
		if (params.claim === true) data.claim = true;
		const status = asString(params.status);
		if (status) data.status = status;
		const newStatus = asString(params.newStatus);
		if (newStatus) data.newStatus = newStatus;
	}

	if (action === "comment_add") {
		const text = asString(params.text);
		if (text) data.commentChars = text.length;
	}

	if (action === "close") {
		const reason = asString(params.reason);
		if (reason) data.reason = truncateForLog(reason, 140);
	}
	if (response.ok) {
		registry.pushEvent(systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `tasks ${action}${issueId ? ` ${issueId}` : ""} by ${actor}`,
			data,
		});
		return;
	}

	registry.pushEvent(systemAgentId, {
		type: "log",
		ts: Date.now(),
		level: "warn",
		message: `tasks ${action}${issueId ? ` ${issueId}` : ""} by ${actor} failed: ${response.error}`,
		data: {
			...data,
			error: response.error,
		},
	});
}

async function executeTasksToolAction(
	tasksClient: TaskStoreClient,
	request: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
	const rec = asRecord(request);
	if (!rec) return { ok: false, error: "Invalid tasks request payload" };

	const action = asString(rec.action)?.toLowerCase();
	if (!action) return { ok: false, error: "Missing tasks action" };

	const params = asRecord(rec.params) ?? rec;
	const fallbackTaskId = asString(rec.defaultTaskId) ?? asString(params.defaultTaskId);
	const issueId = asString(params.id) ?? fallbackTaskId;
	const actor = asString(rec.actor) ?? asString(params.actor) ?? undefined;
	const includeClosed = params.includeClosed === true;
	const requestedStatus = asString(params.status);
	const applyDefaultVisibility = !includeClosed && !requestedStatus;
	const effectiveStatus = requestedStatus ?? null;
	const parseListArgs = (): string[] => {
		const args: string[] = [];
		if (includeClosed) args.push("--all");
		if (effectiveStatus) args.push("--status", effectiveStatus);
		const type = asString(params.type);
		if (type) args.push("--type", type);
		const limit = asFiniteInt(params.limit);
		const effectiveLimit = typeof limit === "number" ? limit : LIMIT_TASK_LIST_DEFAULT;
		args.push("--limit", String(Math.max(0, effectiveLimit)));
		return args;
	};

	try {
		switch (action) {
			case "ready": {
				return { ok: true, data: (await tasksClient.ready()).map(issue => toCompactTaskListIssue(issue)) };
			}
			case "list": {
				const issues = await tasksClient.list(parseListArgs());
				const sortedIssues = [...issues].sort((a, b) => {
					const aTime = parseTimestampMs(a.updated_at);
					const bTime = parseTimestampMs(b.updated_at);
					return bTime - aTime;
				});
				const visibleIssues = applyDefaultVisibility
					? sortedIssues.filter(issue => !isClosedTaskIssue(issue) && !isTerminalAgentStatus(issue.status))
					: sortedIssues;
				return { ok: true, data: visibleIssues.map(issue => toCompactTaskListIssue(issue)) };
			}
			case "types": {
				return { ok: true, data: await tasksClient.types() };
			}
			case "show": {
				if (!issueId) return { ok: false, error: "id is required for show" };
				return { ok: true, data: await tasksClient.show(issueId) };
			}
			case "comments": {
				if (!issueId) return { ok: false, error: "id is required for comments" };
				return { ok: true, data: await tasksClient.comments(issueId) };
			}
			case "comment_add": {
				if (!issueId) return { ok: false, error: "id is required for comment_add" };
				const text = asString(params.text);
				if (!text) return { ok: false, error: "text is required for comment_add" };
				return { ok: true, data: await tasksClient.comment(issueId, text, actor) };
			}
			case "create": {
				if (Array.isArray(params.issues)) {
					if (!tasksClient.createBatch) {
						return { ok: false, error: "Batch create not supported by this store implementation" };
					}
					const batchResult = await tasksClient.createBatch(params.issues as BatchCreateIssueInput[]);
					return { ok: true, data: batchResult };
				}

				const title = asString(params.title);
				if (!title) return { ok: false, error: "title is required for create" };
				const description = asString(params.description);
				const priority = asFiniteInt(params.priority);
				const dependsOnArray = asStringArray(params.depends_on);
				const dependsOnString = asString(params.depends_on);
				const dependsOn = dependsOnArray.length > 0 ? dependsOnArray : (dependsOnString ?? undefined);
				const referencesArray = asStringArray(params.references);
				const referencesString = asString(params.references);
				const references = referencesArray.length > 0 ? referencesArray : (referencesString ?? undefined);
				const createInput: TaskCreateInput = {
					type: asString(params.type) ?? "task",
					labels: asStringArray(params.labels),
					assignee: asString(params.assignee),
					depends_on: dependsOn,
					references,
				};
				const created = await tasksClient.create(title, description, priority ?? undefined, createInput);
				return { ok: true, data: created };
			}
			case "update": {
				if (!issueId) return { ok: false, error: "id is required for update" };
				const patch: TaskUpdateInput = {
					claim: params.claim === true,
				};
				const newStatus = asString(params.newStatus);
				if (newStatus) patch.newStatus = newStatus;
				const status = asString(params.status);
				if (status) patch.status = status;
				if (Array.isArray(params.labels)) patch.labels = asStringArray(params.labels);
				if (Object.hasOwn(params, "references")) {
					if (Array.isArray(params.references)) {
						patch.references = asStringArray(params.references);
					} else if (typeof params.references === "string") {
						patch.references = asString(params.references) ?? [];
					}
				}
				const priority = asFiniteInt(params.priority);
				if (typeof priority === "number") patch.priority = priority;
				if (Object.hasOwn(params, "assignee")) {
					patch.assignee = params.assignee === null ? null : asString(params.assignee);
				}
				await tasksClient.update(issueId, patch);
				const dependsOnArray = asStringArray(params.depends_on);
				const dependsOnString = asString(params.depends_on);
				const dependsOn = dependsOnArray.length > 0 ? dependsOnArray : (dependsOnString ?? undefined);
				if (dependsOn) {
					const ids = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
					const seen = new Set<string>();
					for (const depId of ids) {
						const trimmed = depId.trim();
						if (trimmed && !seen.has(trimmed)) {
							seen.add(trimmed);
							await tasksClient.depAdd(issueId, trimmed);
						}
					}
				}
				return { ok: true, data: await tasksClient.show(issueId) };
			}
			case "close": {
				if (!issueId) return { ok: false, error: "id is required for close" };
				const reason = asString(params.reason) ?? undefined;
				await tasksClient.close(issueId, reason);
				return { ok: true, data: await tasksClient.show(issueId) };
			}
			case "search": {
				const query = asString(params.query);
				if (!query) return { ok: false, error: "query is required for search" };
				const limit = asFiniteInt(params.limit);
				const effectiveLimit = typeof limit === "number" ? limit : LIMIT_TASK_LIST_DEFAULT;
				const options: TaskSearchInput = {
					status: requestedStatus ?? null,
					limit: effectiveLimit,
				};
				const issues = await tasksClient.search(query, options);
				const sortedIssues = [...issues].sort((a, b) => {
					const aTime = parseTimestampMs(a.updated_at);
					const bTime = parseTimestampMs(b.updated_at);
					return bTime - aTime;
				});
				return { ok: true, data: sortedIssues.map(issue => toCompactTaskListIssue(issue)) };
			}
			case "query": {
				const query = asString(params.query);
				if (!query) return { ok: false, error: "query is required for query" };
				const queryArgs: string[] = [];
				if (params.includeClosed === true) queryArgs.push("--all");
				const limit = asFiniteInt(params.limit);
				if (typeof limit === "number") queryArgs.push("--limit", String(Math.max(0, limit)));
				return {
					ok: true,
					data: (await tasksClient.query(query, queryArgs)).map(issue => toCompactTaskListIssue(issue)),
				};
			}
			case "dep_tree": {
				if (!issueId) return { ok: false, error: "id is required for dep_tree" };
				const opts: TaskDepTreeInput = {
					direction: asString(params.direction) ?? undefined,
					status: asString(params.status) ?? undefined,
					maxDepth: asFiniteInt(params.maxDepth) ?? undefined,
				};
				return { ok: true, data: await tasksClient.depTree(issueId, opts) };
			}
			case "activity": {
				const limit = asFiniteInt(params.limit);
				return { ok: true, data: await tasksClient.activity({ limit: limit ?? undefined }) };
			}
			case "delete": {
				if (!issueId) return { ok: false, error: "id is required for delete" };
				return { ok: true, data: await tasksClient.delete(issueId) };
			}
			default:
				return { ok: false, error: `unknown tasks action: ${action}` };
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message };
	}
}

export async function handleIpcMessage(opts: {
	payload: unknown;
	loop: AgentLoop | null;
	registry: AgentRegistry;
	tasksClient: TaskStoreClient;
	systemAgentId: string;
	onRefresh?: () => void;
	onEarlyWake?: () => void;
}): Promise<unknown> {
	const rec =
		opts.payload && typeof opts.payload === "object" && !Array.isArray(opts.payload)
			? (opts.payload as Record<string, unknown>)
			: null;
	const t = rec && typeof rec.type === "string" ? rec.type : "wake";
	const refresh = () => {
		opts.onRefresh?.();
	};

	if (t === "tasks_request") {
		const response = await executeTasksToolAction(opts.tasksClient, rec);
		logTasksMutationForSystem(opts.registry, opts.systemAgentId, rec, response);
		return response;
	}

	if (t === "issuer_advance_lifecycle") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const action = typeof (rec as any)?.action === "string" ? (rec as any).action : "";
		const msg = typeof rec?.message === "string" ? rec.message : "";
		const reason = typeof rec?.reason === "string" ? rec.reason : "";
		const agentId = typeof (rec as any)?.agentId === "string" ? (rec as any).agentId : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: issuer_advance_lifecycle taskId=${taskId} action=${action}`,
			data: opts.payload,
		});
		if (!opts.loop) {
			refresh();
			return { ok: false, summary: "Agent loop unavailable" };
		}
		const result = opts.loop.advanceIssuerLifecycle({
			taskId,
			action,
			message: msg,
			reason,
			agentId: agentId || undefined,
		});
		refresh();
		return result;
	}

	if (t === "finisher_advance_lifecycle") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const action = typeof (rec as any)?.action === "string" ? (rec as any).action : "";
		const msg = typeof rec?.message === "string" ? rec.message : "";
		const reason = typeof rec?.reason === "string" ? rec.reason : "";
		const agentId = typeof (rec as any)?.agentId === "string" ? (rec as any).agentId : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: finisher_advance_lifecycle taskId=${taskId} action=${action}`,
			data: opts.payload,
		});
		if (!opts.loop) {
			refresh();
			return { ok: false, summary: "Agent loop unavailable" };
		}
		const result = opts.loop.advanceFinisherLifecycle({
			taskId,
			action,
			message: msg,
			reason,
			agentId: agentId || undefined,
		});
		refresh();
		return result;
	}

	if (t === "finisher_close_task") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const reason = typeof rec?.reason === "string" ? rec.reason : "";
		const agentId = typeof (rec as any)?.agentId === "string" ? (rec as any).agentId : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: finisher_close_task taskId=${taskId}`,
			data: opts.payload,
		});
		if (!opts.loop) {
			refresh();
			return { ok: false, summary: "Agent loop unavailable" };
		}
		const result = opts.loop.handleFinisherCloseTask({
			taskId,
			reason,
			agentId: agentId || undefined,
		});
		refresh();
		return result;
	}

	if (t === "broadcast") {
		const msg = typeof rec?.message === "string" ? rec.message : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: "IPC: broadcast_to_workers",
			data: opts.payload,
		});

		if (!msg.trim()) {
			refresh();
			return { ok: false, error: "broadcast_to_workers: message is required" };
		}
		void opts.loop?.broadcastToWorkers(msg, opts.payload);
		refresh();
		return { ok: true };
	}

	if (t === "interrupt_agent") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const msg = typeof rec?.message === "string" ? rec.message : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: interrupt_agent taskId=${taskId}`,
			data: opts.payload,
		});

		if (taskId.trim()) {
			const normalizedTaskId = taskId.trim();
			try {
				await opts.tasksClient.show(normalizedTaskId);
			} catch (err) {
				refresh();
				if (isTaskNotFoundError(err)) {
					return { ok: false, error: `interrupt_agent: task ${normalizedTaskId} does not exist` };
				}
				return {
					ok: false,
					error: `interrupt_agent: failed to check task status: ${err instanceof Error ? err.message : err}`,
				};
			}
			void opts.loop?.interruptAgent(normalizedTaskId, msg.trim());
		}
		refresh();
		return;
	}

	if (t === "steer_agent") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const msg = typeof rec?.message === "string" ? rec.message : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: steer_agent taskId=${taskId}`,
			data: opts.payload,
		});
		const normalizedTaskId = taskId.trim();
		const normalizedMessage = msg.trim();
		if (!normalizedTaskId) {
			refresh();
			return { ok: false, error: "steer_agent: taskId is required" };
		}
		if (!normalizedMessage) {
			refresh();
			return { ok: false, error: `steer_agent: message is required for task ${normalizedTaskId}` };
		}
		if (!opts.loop) {
			refresh();
			return { ok: false, error: `steer_agent: agent loop unavailable for task ${normalizedTaskId}` };
		}
		try {
			await opts.tasksClient.show(normalizedTaskId);
		} catch (err) {
			refresh();
			if (isTaskNotFoundError(err)) {
				return { ok: false, error: `steer_agent: task ${normalizedTaskId} does not exist` };
			}
			return {
				ok: false,
				error: `steer_agent: failed to check task status: ${err instanceof Error ? err.message : err}`,
			};
		}
		const activeAgents = opts.registry.getActiveByTask(normalizedTaskId);
		if (activeAgents.length === 0) {
			refresh();
			return {
				ok: false,
				error: `steer_agent: no active agent for task ${normalizedTaskId} (current active agents: none)`,
			};
		}
		const nonFinisherAgents = activeAgents.filter(agent => agent.role !== "finisher");
		if (nonFinisherAgents.length === 0) {
			refresh();
			return {
				ok: false,
				error: `steer_agent: cannot steer finisher agent on task ${normalizedTaskId} (current active roles: finisher)`,
			};
		}
		const steered = await opts.loop.steerAgent(normalizedTaskId, normalizedMessage);
		refresh();
		if (!steered) {
			return {
				ok: false,
				error: `steer_agent: steer request was not applied for task ${normalizedTaskId} (current active roles: ${activeAgents.map(agent => agent.role).join(", ")})`,
			};
		}
		return { ok: true };
	}
	if (t === "replace_agent") {
		const role = typeof (rec as any)?.role === "string" ? (rec as any).role : "";
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const context = typeof (rec as any)?.context === "string" ? (rec as any).context : "";
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: replace_agent role=${role} taskId=${taskId}`,
			data: opts.payload,
		});
		const normalizedRole = role.trim();
		const normalizedTaskId = taskId.trim();
		const normalizedContext = context.trim();
		if (!normalizedRole || !["finisher", "issuer", "worker"].includes(normalizedRole)) {
			refresh();
			return { ok: false, error: "replace_agent: role must be one of finisher, issuer, worker" };
		}
		if (!normalizedTaskId) {
			refresh();
			return { ok: false, error: "replace_agent: taskId is required" };
		}
		if (!opts.loop) {
			refresh();
			return { ok: false, error: `replace_agent: agent loop unavailable for task ${normalizedTaskId}` };
		}
		if (opts.loop.isPaused()) {
			refresh();
			return { ok: false, error: "replace_agent: agent loop is paused" };
		}

		// Check task status - reject if closed, track if blocked for recovery
		let taskIsBlocked = false;
		try {
			const task = await opts.tasksClient.show(normalizedTaskId);
			if (task.status === "closed") {
				refresh();
				return { ok: false, error: "Task is closed. Create a new task instead." };
			}
			taskIsBlocked = task.status === "blocked";
		} catch (err) {
			refresh();
			if (isTaskNotFoundError(err)) {
				return { ok: false, error: `replace_agent: task ${normalizedTaskId} does not exist` };
			}
			return {
				ok: false,
				error: `replace_agent: failed to check task status: ${err instanceof Error ? err.message : err}`,
			};
		}
		const activeAgents = opts.registry.getActiveByTask(normalizedTaskId);
		if (activeAgents.length === 0 && !taskIsBlocked) {
			refresh();
			return {
				ok: false,
				error: `replace_agent: no active agent for task ${normalizedTaskId} (current active agents: none)`,
			};
		}
		const nonFinisherAgents = activeAgents.filter(agent => agent.role !== "finisher");
		if (nonFinisherAgents.length === 0 && !taskIsBlocked) {
			refresh();
			return {
				ok: false,
				error: `replace_agent: cannot replace finisher agent on task ${normalizedTaskId} (finisher manages its own lifecycle; current active roles: finisher)`,
			};
		}
		try {
			await opts.loop.spawnAgentBySingularity({
				role: normalizedRole as "finisher" | "issuer" | "worker",
				taskId: normalizedTaskId,
				context: normalizedContext || undefined,
			});
			refresh();
			return { ok: true };
		} catch (err) {
			refresh();
			return {
				ok: false,
				error: `replace_agent: failed to spawn replacement for task ${normalizedTaskId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			};
		}
	}

	if (t === "stop_agents_for_task") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId : "";
		const includeFinisher = (rec as any)?.includeFinisher === true;
		const waitForCompletion = (rec as any)?.waitForCompletion === true;
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: stop_agents_for_task taskId=${taskId} includeFinisher=${includeFinisher} waitForCompletion=${waitForCompletion}`,
			data: opts.payload,
		});
		if (taskId.trim()) {
			const stopPromise = opts.loop?.stopAgentsForTask(taskId.trim(), { includeFinisher });
			if (waitForCompletion) {
				await stopPromise;
			} else {
				void stopPromise;
			}
		}
		refresh();
		return;
	}

	if (t === "complain") {
		const files = Array.isArray((rec as any)?.files)
			? (rec as any).files
					.filter((file: unknown): file is string => typeof file === "string")
					.map((file: string) => file.trim())
					.filter((file: string) => file.length > 0)
			: [];
		const reason = typeof rec?.reason === "string" ? rec.reason : "";
		const complainantAgentId =
			typeof (rec as any)?.complainantAgentId === "string" ? (rec as any).complainantAgentId : undefined;
		const complainantTaskId =
			typeof (rec as any)?.complainantTaskId === "string" ? (rec as any).complainantTaskId : undefined;
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: complain files=${files.length}`,
			data: opts.payload,
		});
		if (!opts.loop) {
			refresh();
			return { ok: false, summary: "Agent loop unavailable" };
		}
		const result = await opts.loop.complain({
			complainantAgentId,
			complainantTaskId,
			files,
			reason,
		});
		refresh();
		return result;
	}

	if (t === "revoke_complaint") {
		const files = Array.isArray((rec as any)?.files)
			? (rec as any).files
					.filter((file: unknown): file is string => typeof file === "string")
					.map((file: string) => file.trim())
					.filter((file: string) => file.length > 0)
			: undefined;
		const complainantAgentId =
			typeof (rec as any)?.complainantAgentId === "string" ? (rec as any).complainantAgentId : undefined;
		const complainantTaskId =
			typeof (rec as any)?.complainantTaskId === "string" ? (rec as any).complainantTaskId : undefined;
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: revoke_complaint files=${files?.length ?? 0}`,
			data: opts.payload,
		});
		if (!opts.loop) {
			refresh();
			return { ok: false, summary: "Agent loop unavailable" };
		}
		const result = await opts.loop.revokeComplaint({
			complainantAgentId,
			complainantTaskId,
			files,
		});
		refresh();
		return result;
	}

	if (t === "wait_for_agent") {
		const agentId = typeof (rec as any)?.agentId === "string" ? (rec as any).agentId.trim() : "";
		const timeoutMs =
			typeof (rec as any)?.timeoutMs === "number" && Number.isFinite((rec as any).timeoutMs)
				? Math.max(TIMEOUT_MIN_MS, Math.trunc((rec as any).timeoutMs))
				: TIMEOUT_AGENT_WAIT_MS;
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: `IPC: wait_for_agent agentId=${agentId}`,
			data: opts.payload,
		});
		if (!agentId) {
			refresh();
			return { ok: false, error: "wait_for_agent: agentId is required" };
		}
		const result = await waitForRegistryAgentExit(opts.registry, agentId, timeoutMs);
		refresh();
		return result;
	}

	if (t === "list_active_agents") {
		return {
			ok: true,
			activeAgents: opts.registry.listActiveSummaries(),
		};
	}

	if (t === "list_task_agents") {
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId.trim() : "";
		if (!taskId) {
			return { ok: false, summary: "list_task_agents: taskId is required" };
		}
		const agents = opts.registry.getByTask(taskId).map(agent => ({
			id: agent.id,
			tasksAgentId: agent.tasksAgentId,
			role: agent.role,
			state: agent.status,
			lastActivity: agent.lastActivity,
			source: "live",
		}));
		const persistedAgents = await listPersistedTaskAgents(opts.tasksClient, taskId);
		const seen = new Set<string>();
		for (const agent of agents) {
			if (agent.id) seen.add(agent.id);
			if (agent.tasksAgentId) seen.add(agent.tasksAgentId);
		}
		for (const persisted of persistedAgents) {
			if (seen.has(persisted.id) || seen.has(persisted.tasksAgentId)) continue;
			agents.push(persisted);
		}
		agents.sort((a, b) => b.lastActivity - a.lastActivity);
		return {
			ok: true,
			taskId,
			agents,
		};
	}

	if (t === "read_message_history") {
		const agentId = typeof (rec as any)?.agentId === "string" ? (rec as any).agentId.trim() : "";
		const limit = typeof (rec as any)?.limit === "number" ? (rec as any).limit : LIMIT_MESSAGE_HISTORY_DEFAULT;
		const taskId = typeof (rec as any)?.taskId === "string" ? (rec as any).taskId.trim() : "";
		if (!agentId) {
			return { ok: false, summary: "read_message_history: agentId is required" };
		}
		if (taskId) {
			const targetAgent = resolveRegistryAgent(opts.registry, agentId);
			if (targetAgent) {
				if (targetAgent.taskId !== taskId) {
					return {
						ok: false,
						summary: `read_message_history rejected: agent ${agentId} is outside task ${taskId}`,
					};
				}
			} else {
				const persistedTaskId = await resolveAgentTaskIdFromStore(opts.tasksClient, agentId);
				if (!persistedTaskId) {
					return { ok: false, summary: `read_message_history rejected: agent ${agentId} was not found` };
				}
				if (persistedTaskId !== taskId) {
					return {
						ok: false,
						summary: `read_message_history rejected: agent ${agentId} is outside task ${taskId}`,
					};
				}
			}
		}
		const history = await opts.registry.readMessageHistory(agentId, limit);
		return {
			ok: true,
			history,
		};
	}

	if (t === "start_tasks") {
		const rawCount = typeof rec?.count === "number" && Number.isFinite(rec.count) ? Math.trunc(rec.count) : 0;
		const count = Math.max(0, rawCount);
		opts.registry.pushEvent(opts.systemAgentId, {
			type: "log",
			ts: Date.now(),
			level: "info",
			message: "IPC: start_tasks",
			data: opts.payload,
		});
		if (!opts.loop?.isRunning()) {
			refresh();
			return { ok: false, summary: "Agent loop not running" };
		}
		const result = await opts.loop.startTasks(count || undefined);
		refresh();
		return { ok: true, ...result };
	}

	opts.registry.pushEvent(opts.systemAgentId, {
		type: "log",
		ts: Date.now(),
		level: "info",
		message: "IPC: wake",
		data: opts.payload,
	});
	if (opts.loop?.isRunning()) {
		if (opts.loop.isPaused()) opts.loop.resume();
		opts.loop.wake();
	} else {
		opts.onEarlyWake?.();
	}
	refresh();
}
