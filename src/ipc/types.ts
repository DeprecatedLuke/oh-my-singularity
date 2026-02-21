import {
	getAgentLifecycleConfig,
	getReplaceableAgents,
	LIMIT_MESSAGE_HISTORY_DEFAULT,
	type LifecycleAction,
	TIMEOUT_AGENT_WAIT_MS,
	TIMEOUT_MIN_MS,
} from "../config/constants";
export type ReplaceAgentTypeField = string;

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

export interface AdvanceLifecycleMessage extends IPCMessageBase {
	type: "advance_lifecycle";
	agentType: string;
	taskId: string;
	action: string;
	target: string;
	message: string;
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
	agent: ReplaceAgentTypeField;
	taskId: string;
	context: string;
}

export interface StopAgentsForTaskMessage extends IPCMessageBase {
	type: "stop_agents_for_task";
	taskId: string;
	includeFinisher: boolean;
	waitForCompletion: boolean;
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
	advance_lifecycle: AdvanceLifecycleMessage;
	merger_complete: MergerCompleteMessage;
	merger_conflict: MergerConflictMessage;
	broadcast: BroadcastMessage;
	interrupt_agent: InterruptAgentMessage;
	steer_agent: SteerAgentMessage;
	replace_agent: ReplaceAgentMessage;
	stop_agents_for_task: StopAgentsForTaskMessage;
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
	"advance_lifecycle",
	"merger_complete",
	"merger_conflict",
	"broadcast",
	"interrupt_agent",
	"steer_agent",
	"replace_agent",
	"stop_agents_for_task",
	"wait_for_agent",
	"list_active_agents",
	"list_task_agents",
	"read_message_history",
] as const;

const REPLACEABLE_AGENTS = getReplaceableAgents();
const LIFECYCLE_ACTIONS = new Set<LifecycleAction>(["close", "block", "advance"]);
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
		case "advance_lifecycle": {
			const agentType = readStringField(rec, rawType, "agentType", { trim: true });
			if (!agentType.ok) return agentType;
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const action = readStringField(rec, rawType, "action", { trim: true });
			if (!action.ok) return action;
			if (!LIFECYCLE_ACTIONS.has(action.value as LifecycleAction)) {
				return {
					ok: false,
					error: `Invalid IPC payload for "${rawType}": "action" must be one of close, block, advance (received "${action.value || "(empty)"}").`,
				};
			}
			const target = readStringField(rec, rawType, "target");
			if (!target.ok) return target;
			if (action.value === "advance") {
				if (!target.value.trim()) {
					return {
						ok: false,
						error: `Invalid IPC payload for "${rawType}": "target" is required when action is "advance".`,
					};
				}
				const lifecycleCfg = getAgentLifecycleConfig(agentType.value);
				if (lifecycleCfg && !lifecycleCfg.allowedAdvanceTargets.includes(target.value.trim())) {
					return {
						ok: false,
						error: `Invalid IPC payload for "${rawType}": target "${target.value}" is not a valid advance target for agent type "${agentType.value}". Valid targets: ${lifecycleCfg.allowedAdvanceTargets.join(", ")}.`,
					};
				}
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
					agentType: agentType.value,
					taskId: taskId.value,
					action: action.value,
					target: target.value,
					message: message.value,
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
			const agent = readStringField(rec, rawType, "agent");
			if (!agent.ok) return agent;
			const taskId = readStringField(rec, rawType, "taskId");
			if (!taskId.ok) return taskId;
			const context = readStringField(rec, rawType, "context");
			if (!context.ok) return context;

			const normalizedAgent = agent.value.trim();
			if (normalizedAgent && !REPLACEABLE_AGENTS.has(normalizedAgent)) {
				return {
					ok: false,
					error: `Invalid IPC payload for "${rawType}": "agent" must be one of ${[...REPLACEABLE_AGENTS].join(", ")} (received "${normalizedAgent}").`,
				};
			}
			const typedAgent: ReplaceAgentTypeField = normalizedAgent || "";

			return {
				ok: true,
				message: {
					...rec,
					type: rawType,
					agent: typedAgent,
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
