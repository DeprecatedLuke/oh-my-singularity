import { LIMIT_MESSAGE_HISTORY_DEFAULT, TIMEOUT_AGENT_WAIT_MS, TIMEOUT_MIN_MS } from "../config/constants";
export type ReplaceAgentRole = "finisher" | "issuer" | "worker";
export type ReplaceAgentRoleField = ReplaceAgentRole | "";

interface IPCMessageBase {
	type: string;
	[key: string]: unknown;
}

export interface WakeMessage extends IPCMessageBase {
	type: "wake";
}

export interface StartTasksMessage extends IPCMessageBase {
	type: "start_tasks";
	count?: number; // optional max tasks to start
}

export interface TasksRequestMessage extends IPCMessageBase {
	type: "tasks_request";
	action: string;
	params?: Record<string, unknown>;
	defaultTaskId?: string;
}

export interface IssuerAdvanceLifecycleMessage extends IPCMessageBase {
	type: "issuer_advance_lifecycle";
	taskId: string;
	action: string;
	message: string;
	reason: string;
	agentId: string;
}

export interface FastWorkerAdvanceLifecycleMessage extends IPCMessageBase {
	type: "fast_worker_advance_lifecycle";
	taskId: string;
	action: string;
	message: string;
	reason: string;
	agentId: string;
}

export interface FastWorkerCloseTaskMessage extends IPCMessageBase {
	type: "fast_worker_close_task";
	taskId: string;
	reason: string;
	agentId: string;
}

export interface FinisherAdvanceLifecycleMessage extends IPCMessageBase {
	type: "finisher_advance_lifecycle";
	taskId: string;
	action: string;
	message: string;
	reason: string;
	agentId: string;
}

export interface FinisherCloseTaskMessage extends IPCMessageBase {
	type: "finisher_close_task";
	taskId: string;
	reason: string;
	agentId: string;
}

export interface MergerCompleteMessage extends IPCMessageBase {
	type: "merger_complete";
	taskId: string;
	reason: string;
	agentId: string;
}

export interface MergerConflictMessage extends IPCMessageBase {
	type: "merger_conflict";
	taskId: string;
	reason: string;
	agentId: string;
}

export interface BroadcastMessage extends IPCMessageBase {
	type: "broadcast";
	message: string;
}

export interface InterruptAgentMessage extends IPCMessageBase {
	type: "interrupt_agent";
	taskId: string;
	message: string;
}

export interface SteerAgentMessage extends IPCMessageBase {
	type: "steer_agent";
	taskId: string;
	message: string;
}

export interface ReplaceAgentMessage extends IPCMessageBase {
	type: "replace_agent";
	role: ReplaceAgentRoleField;
	taskId: string;
	context: string;
}

export interface StopAgentsForTaskMessage extends IPCMessageBase {
	type: "stop_agents_for_task";
	taskId: string;
	includeFinisher: boolean;
	waitForCompletion: boolean;
}

export interface ComplainMessage extends IPCMessageBase {
	type: "complain";
	files: string[];
	reason: string;
	complainantAgentId?: string;
	complainantTaskId?: string;
}

export interface RevokeComplaintMessage extends IPCMessageBase {
	type: "revoke_complaint";
	files?: string[];
	complainantAgentId?: string;
	complainantTaskId?: string;
}

export interface WaitForAgentMessage extends IPCMessageBase {
	type: "wait_for_agent";
	agentId: string;
	timeoutMs: number;
}

export interface ListActiveAgentsMessage extends IPCMessageBase {
	type: "list_active_agents";
}

export interface ListTaskAgentsMessage extends IPCMessageBase {
	type: "list_task_agents";
	taskId: string;
}

export interface ReadMessageHistoryMessage extends IPCMessageBase {
	type: "read_message_history";
	agentId: string;
	limit: number;
	taskId: string;
}

export interface IPCMessageMap {
	wake: WakeMessage;
	start_tasks: StartTasksMessage;

	tasks_request: TasksRequestMessage;
	issuer_advance_lifecycle: IssuerAdvanceLifecycleMessage;
	fast_worker_advance_lifecycle: FastWorkerAdvanceLifecycleMessage;
	fast_worker_close_task: FastWorkerCloseTaskMessage;
	finisher_advance_lifecycle: FinisherAdvanceLifecycleMessage;
	finisher_close_task: FinisherCloseTaskMessage;
	merger_complete: MergerCompleteMessage;
	merger_conflict: MergerConflictMessage;
	broadcast: BroadcastMessage;
	interrupt_agent: InterruptAgentMessage;
	steer_agent: SteerAgentMessage;
	replace_agent: ReplaceAgentMessage;
	stop_agents_for_task: StopAgentsForTaskMessage;
	complain: ComplainMessage;
	revoke_complaint: RevokeComplaintMessage;
	wait_for_agent: WaitForAgentMessage;
	list_active_agents: ListActiveAgentsMessage;
	list_task_agents: ListTaskAgentsMessage;
	read_message_history: ReadMessageHistoryMessage;
}

export interface CustomIPCMessages {}

type CoreIPCMessage = IPCMessageMap[keyof IPCMessageMap];
type CustomIPCMessage = keyof CustomIPCMessages extends never ? never : CustomIPCMessages[keyof CustomIPCMessages];

export type IPCMessage = CoreIPCMessage | CustomIPCMessage;

export type ParseIPCMessageResult = { ok: true; message: CoreIPCMessage } | { ok: false; error: string };

type FieldParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const CORE_IPC_MESSAGE_TYPES = [
	"wake",
	"start_tasks",

	"tasks_request",
	"issuer_advance_lifecycle",
	"fast_worker_advance_lifecycle",
	"fast_worker_close_task",
	"finisher_advance_lifecycle",
	"finisher_close_task",
	"merger_complete",
	"merger_conflict",
	"broadcast",
	"interrupt_agent",
	"steer_agent",
	"replace_agent",
	"stop_agents_for_task",
	"complain",
	"revoke_complaint",
	"wait_for_agent",
	"list_active_agents",
	"list_task_agents",
	"read_message_history",
] as const;

const REPLACE_AGENT_ROLES = new Set<ReplaceAgentRole>(["finisher", "issuer", "worker"]);
const FAST_WORKER_LIFECYCLE_ACTIONS = new Set(["done", "escalate"]);
const FINISHER_LIFECYCLE_ACTIONS = new Set(["worker", "issuer", "defer"]);
const WAIT_FOR_AGENT_DEFAULT_TIMEOUT_MS = TIMEOUT_AGENT_WAIT_MS;

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function describeValueType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function invalidField(
	messageType: string,
	field: string,
	expected: string,
	value: unknown,
): { ok: false; error: string } {
	return {
		ok: false,
		error: `Invalid IPC payload for "${messageType}": "${field}" must be ${expected} (received ${describeValueType(value)}).`,
	};
}

function readStringField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
	options?: { trim?: boolean; fallback?: string },
): FieldParseResult<string> {
	const value = rec[field];
	if (value === undefined) {
		return { ok: true, value: options?.fallback ?? "" };
	}
	if (typeof value !== "string") {
		return invalidField(messageType, field, "a string", value);
	}
	return { ok: true, value: options?.trim ? value.trim() : value };
}

function readOptionalStringField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
	options?: { trim?: boolean },
): FieldParseResult<string | undefined> {
	const value = rec[field];
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "string") {
		return invalidField(messageType, field, "a string", value);
	}
	return { ok: true, value: options?.trim ? value.trim() : value };
}

function readRecordField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
): FieldParseResult<Record<string, unknown> | undefined> {
	const value = rec[field];
	if (value === undefined) return { ok: true, value: undefined };
	const nested = asRecord(value);
	if (!nested) {
		return invalidField(messageType, field, "an object", value);
	}
	return { ok: true, value: nested };
}

function readBooleanField(rec: Record<string, unknown>, messageType: string, field: string): FieldParseResult<boolean> {
	const value = rec[field];
	if (value === undefined) return { ok: true, value: false };
	if (typeof value !== "boolean") {
		return invalidField(messageType, field, "a boolean", value);
	}
	return { ok: true, value: value === true };
}

function readNumberField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
	options: { fallback: number; truncate?: boolean; min?: number },
): FieldParseResult<number> {
	const value = rec[field];
	if (value === undefined) return { ok: true, value: options.fallback };
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return invalidField(messageType, field, "a finite number", value);
	}
	let normalized = options.truncate ? Math.trunc(value) : value;
	if (typeof options.min === "number") {
		normalized = Math.max(options.min, normalized);
	}
	return { ok: true, value: normalized };
}

function readFilesField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
	optional: false,
): FieldParseResult<string[]>;
function readFilesField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
	optional: true,
): FieldParseResult<string[] | undefined>;
function readFilesField(
	rec: Record<string, unknown>,
	messageType: string,
	field: string,
	optional: boolean,
): FieldParseResult<string[] | undefined> {
	const value = rec[field];
	if (value === undefined) return { ok: true, value: optional ? undefined : [] };
	if (!Array.isArray(value)) {
		return invalidField(messageType, field, "an array of strings", value);
	}
	const files = value
		.filter((file: unknown): file is string => typeof file === "string")
		.map((file: string) => file.trim())
		.filter((file: string) => file.length > 0);
	return { ok: true, value: files };
}

export function parseIPCMessage(payload: unknown): ParseIPCMessageResult {
	const rec = asRecord(payload);
	if (!rec) return { ok: true, message: { type: "wake" } };

	const rawType = rec.type;
	if (typeof rawType !== "string") {
		return { ok: true, message: { ...rec, type: "wake" } };
	}

	switch (rawType) {
		case "wake":
			return { ok: true, message: { ...rec, type: rawType } };
		case "start_tasks": {
			const count = readNumberField(rec, rawType, "count", { fallback: 0, truncate: true, min: 0 });
			if (!count.ok) return count;
			return { ok: true, message: { ...rec, type: rawType, count: count.value } };
		}

		case "tasks_request": {
			const action = readStringField(rec, rawType, "action");
			if (!action.ok) return action;
			const params = readRecordField(rec, rawType, "params");
			if (!params.ok) return params;
			const defaultTaskId = readOptionalStringField(rec, rawType, "defaultTaskId");
			if (!defaultTaskId.ok) return defaultTaskId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					action: action.value,
					params: params.value,
					defaultTaskId: defaultTaskId.value,
				},
			};
		}
		case "issuer_advance_lifecycle": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const action = readStringField(rec, rawType, "action");
			if (!action.ok) return action;
			const message = readStringField(rec, rawType, "message");
			if (!message.ok) return message;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					action: action.value,
					message: message.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}
		case "fast_worker_advance_lifecycle": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const action = readStringField(rec, rawType, "action", { trim: true });
			if (!action.ok) return action;
			if (!FAST_WORKER_LIFECYCLE_ACTIONS.has(action.value)) {
				return {
					ok: false,
					error: `Invalid IPC payload for "${rawType}": "action" must be one of done, escalate (received "${action.value || "(empty)"}").`,
				};
			}
			const message = readStringField(rec, rawType, "message");
			if (!message.ok) return message;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					action: action.value,
					message: message.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}

		case "fast_worker_close_task": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}

		case "finisher_advance_lifecycle": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const action = readStringField(rec, rawType, "action", { trim: true });
			if (!action.ok) return action;
			if (!FINISHER_LIFECYCLE_ACTIONS.has(action.value)) {
				return {
					ok: false,
					error: `Invalid IPC payload for "${rawType}": "action" must be one of worker, issuer, defer (received "${action.value || "(empty)"}").`,
				};
			}
			const message = readStringField(rec, rawType, "message");
			if (!message.ok) return message;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					action: action.value,
					message: message.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}
		case "finisher_close_task": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}

		case "merger_complete": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}
		case "merger_conflict": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const agentId = readStringField(rec, rawType, "agentId");
			if (!agentId.ok) return agentId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					reason: reason.value,
					agentId: agentId.value,
				},
			};
		}
		case "broadcast": {
			const message = readStringField(rec, rawType, "message");
			if (!message.ok) return message;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					message: message.value,
				},
			};
		}
		case "interrupt_agent": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const message = readStringField(rec, rawType, "message");
			if (!message.ok) return message;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					message: message.value,
				},
			};
		}
		case "steer_agent": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const message = readStringField(rec, rawType, "message");
			if (!message.ok) return message;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					message: message.value,
				},
			};
		}
		case "replace_agent": {
			const role = readStringField(rec, rawType, "role");
			if (!role.ok) return role;
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const context = readStringField(rec, rawType, "context");
			if (!context.ok) return context;

			const normalizedRole = role.value.trim();
			if (normalizedRole && !REPLACE_AGENT_ROLES.has(normalizedRole as ReplaceAgentRole)) {
				return {
					ok: false,
					error: `Invalid IPC payload for "${rawType}": "role" must be one of finisher, issuer, worker (received "${normalizedRole}").`,
				};
			}
			const typedRole: ReplaceAgentRoleField = normalizedRole ? (normalizedRole as ReplaceAgentRole) : "";

			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					role: typedRole,
					taskId: taskId.value,
					context: context.value,
				},
			};
		}
		case "stop_agents_for_task": {
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const includeFinisher = readBooleanField(rec, rawType, "includeFinisher");
			if (!includeFinisher.ok) return includeFinisher;
			const waitForCompletion = readBooleanField(rec, rawType, "waitForCompletion");
			if (!waitForCompletion.ok) return waitForCompletion;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
					includeFinisher: includeFinisher.value,
					waitForCompletion: waitForCompletion.value,
				},
			};
		}
		case "complain": {
			const files = readFilesField(rec, rawType, "files", false);
			if (!files.ok) return files;
			const reason = readStringField(rec, rawType, "reason");
			if (!reason.ok) return reason;
			const complainantAgentId = readOptionalStringField(rec, rawType, "complainantAgentId");
			if (!complainantAgentId.ok) return complainantAgentId;
			const complainantTaskId = readOptionalStringField(rec, rawType, "complainantTaskId");
			if (!complainantTaskId.ok) return complainantTaskId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					files: files.value,
					reason: reason.value,
					complainantAgentId: complainantAgentId.value,
					complainantTaskId: complainantTaskId.value,
				},
			};
		}
		case "revoke_complaint": {
			const files = readFilesField(rec, rawType, "files", true);
			if (!files.ok) return files;
			const complainantAgentId = readOptionalStringField(rec, rawType, "complainantAgentId");
			if (!complainantAgentId.ok) return complainantAgentId;
			const complainantTaskId = readOptionalStringField(rec, rawType, "complainantTaskId");
			if (!complainantTaskId.ok) return complainantTaskId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					files: files.value,
					complainantAgentId: complainantAgentId.value,
					complainantTaskId: complainantTaskId.value,
				},
			};
		}
		case "wait_for_agent": {
			const agentId = readStringField(rec, rawType, "agentId", { trim: true });
			if (!agentId.ok) return agentId;
			const timeoutMs = readNumberField(rec, rawType, "timeoutMs", {
				fallback: WAIT_FOR_AGENT_DEFAULT_TIMEOUT_MS,
				truncate: true,
				min: TIMEOUT_MIN_MS,
			});
			if (!timeoutMs.ok) return timeoutMs;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					agentId: agentId.value,
					timeoutMs: timeoutMs.value,
				},
			};
		}
		case "list_active_agents":
			return { ok: true, message: { ...rec, type: rawType } };
		case "list_task_agents": {
			const taskId = readStringField(rec, rawType, "taskId", { trim: true });
			if (!taskId.ok) return taskId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					taskId: taskId.value,
				},
			};
		}
		case "read_message_history": {
			const agentId = readStringField(rec, rawType, "agentId", { trim: true });
			if (!agentId.ok) return agentId;
			const limit = readNumberField(rec, rawType, "limit", { fallback: LIMIT_MESSAGE_HISTORY_DEFAULT });
			if (!limit.ok) return limit;
			const taskId = readStringField(rec, rawType, "taskId", { trim: true });
			if (!taskId.ok) return taskId;
			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					agentId: agentId.value,
					limit: limit.value,
					taskId: taskId.value,
				},
			};
		}
		default:
			return {
				ok: false,
				error: `Unknown IPC message type "${rawType}". Expected one of: ${CORE_IPC_MESSAGE_TYPES.join(", ")}.`,
			};
	}
}
