import { requireSockPath, sendIpc } from "./ipc-client";

import { asRecord, type ExtensionAPI, type UnknownRecord } from "./types";

const HELP_TEXT = [
	"/tasks list — show open tasks with status/priority",
	"/tasks show <id> — show task details and comments",
	"/tasks start — check for ready tasks and start issuers",
	"/tasks stop <id> — stop running agents for task",
	"/tasks delete <id> — delete/cancel task",
].join("\n");

const TERMINAL_AGENT_STATUSES = new Set(["done", "failed", "aborted", "stopped", "dead"]);
const DELETE_FALLBACK_REASON = "Cancelled by user via /tasks delete";

type ParsedInvocation = {
	subcommand: string;
	args: string[];
};

type TasksRequestResult = {
	ok: boolean;
	data: unknown;
	error: string | null;
	response: UnknownRecord | null;
};

export default async function tasksCommandExtension(api: ExtensionAPI): Promise<void> {
	api.registerCommand?.("tasks", {
		description: "Manual task control: list/show/start/stop/delete",
		handler: async (context: unknown) => {
			const { subcommand, args } = parseInvocation(context);
			if (!subcommand || subcommand === "help") {
				await emitCommandOutput(context, HELP_TEXT);
				return;
			}

			try {
				const sockPath = requireSockPath();
				switch (subcommand) {
					case "list": {
						await emitCommandOutput(context, await runList(sockPath));
						return;
					}
					case "show": {
						const id = args[0]?.trim() ?? "";
						if (!id) {
							await emitCommandOutput(context, `tasks show: id is required\n\n${HELP_TEXT}`);
							return;
						}
						await emitCommandOutput(context, await runShow(sockPath, id));
						return;
					}
					case "start": {
						await emitCommandOutput(context, await runStart(sockPath));
						return;
					}
					case "stop": {
						const id = args[0]?.trim() ?? "";
						if (!id) {
							await emitCommandOutput(context, `tasks stop: id is required\n\n${HELP_TEXT}`);
							return;
						}
						await emitCommandOutput(context, await runStop(sockPath, id));
						return;
					}
					case "delete": {
						const id = args[0]?.trim() ?? "";
						if (!id) {
							await emitCommandOutput(context, `tasks delete: id is required\n\n${HELP_TEXT}`);
							return;
						}
						await emitCommandOutput(context, await runDelete(sockPath, id));
						return;
					}
					default:
						await emitCommandOutput(context, `tasks: unknown subcommand '${subcommand}'\n\n${HELP_TEXT}`);
						return;
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await emitCommandOutput(context, `tasks: ${message}`);
			}
		},
	});
}

function parseInvocation(context: unknown): ParsedInvocation {
	const tokens = extractTokens(context);
	if (tokens.length === 0) {
		return { subcommand: "", args: [] };
	}

	const normalizedTokens = [...tokens];
	const first = normalizedTokens[0]?.trim().toLowerCase();
	if (first === "tasks" || first === "/tasks") {
		normalizedTokens.shift();
	}

	const rawSubcommand = normalizedTokens[0]?.trim().toLowerCase() ?? "";
	const subcommand = rawSubcommand.startsWith("/") ? rawSubcommand.slice(1) : rawSubcommand;
	const args = normalizedTokens
		.slice(1)
		.map(part => part.trim())
		.filter(Boolean);

	return { subcommand, args };
}

function extractTokens(context: unknown): string[] {
	const fromContext = extractTokensFromValue(context);
	if (fromContext.length > 0) return fromContext;

	const rec = asRecord(context);
	if (!rec) return [];

	const fromArgs = extractTokensFromValue(rec.args);
	if (fromArgs.length > 0) return fromArgs;

	const fromArgv = extractTokensFromValue(rec.argv);
	if (fromArgv.length > 0) return fromArgv;

	const fromInput = extractTokensFromValue(rec.input);
	if (fromInput.length > 0) return fromInput;

	const fromText = extractTokensFromValue(rec.text);
	if (fromText.length > 0) return fromText;

	const fromCommand = extractTokensFromValue(rec.command);
	if (fromCommand.length > 0) return fromCommand;

	const fromLine = extractTokensFromValue(rec.line);
	if (fromLine.length > 0) return fromLine;

	const subcommand = asString(rec.subcommand);
	if (subcommand) {
		const fromSubcommandArgs = extractTokensFromValue(rec.subcommandArgs);
		if (fromSubcommandArgs.length > 0) {
			return [subcommand, ...fromSubcommandArgs];
		}

		const fromFallbackArgs = extractTokensFromValue(rec.args);
		if (fromFallbackArgs.length > 0) {
			return [subcommand, ...fromFallbackArgs];
		}

		return [subcommand];
	}

	return [];
}

function extractTokensFromValue(value: unknown): string[] {
	if (typeof value === "string") {
		return value
			.trim()
			.split(/\s+/)
			.map(part => part.trim())
			.filter(Boolean);
	}

	if (Array.isArray(value)) {
		return value.map(item => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
	}

	return [];
}

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

async function emitCommandOutput(context: unknown, text: string): Promise<void> {
	const rec = asRecord(context);
	if (rec) {
		for (const key of [
			"respond",
			"reply",
			"output",
			"write",
			"print",
			"send",
			"emit",
			"appendOutput",
			"addOutput",
			"showMessage",
		]) {
			const fn = rec[key];
			if (typeof fn !== "function") continue;
			const handler = fn as (value: unknown) => unknown;
			try {
				await handler(text);
				return;
			} catch {
				try {
					await handler({ type: "text", text });
					return;
				} catch {
					// try next handler
				}
			}
		}
	}

	throw new Error(text);
}

async function runList(sockPath: string): Promise<string> {
	const result = await sendTasksRequest(sockPath, {
		action: "list",
		params: {},
	});
	if (!result.ok) {
		return `tasks list failed: ${result.error ?? "unknown error"}`;
	}

	const issues = toRecordArray(result.data);
	const openIssues = issues.filter(issue => {
		const status = asString(issue.status)?.toLowerCase() ?? "";
		return status !== "closed" && status !== "deferred";
	});
	if (openIssues.length === 0) {
		return "No open tasks.";
	}

	const lines = [`Open tasks (${openIssues.length}):`];
	for (const issue of openIssues) {
		const id = asString(issue.id) ?? "(unknown-id)";
		const status = asString(issue.status) ?? "unknown";
		const priority =
			typeof issue.priority === "number" && Number.isFinite(issue.priority)
				? String(Math.trunc(issue.priority))
				: "?";
		const title = asString(issue.title) ?? "(untitled)";
		lines.push(`- ${id} [${status}] p${priority} ${title}`);
	}
	return lines.join("\n");
}

async function runShow(sockPath: string, id: string): Promise<string> {
	const showResult = await sendTasksRequest(sockPath, {
		action: "show",
		params: { id },
	});
	if (!showResult.ok) {
		return `tasks show ${id} failed: ${showResult.error ?? "unknown error"}`;
	}

	const issue = asRecord(showResult.data);
	if (!issue) {
		return `tasks show ${id} failed: unexpected response shape`;
	}

	const commentsResult = await sendTasksRequest(sockPath, {
		action: "comments",
		params: { id },
	});

	const lines: string[] = [];
	const title = asString(issue.title) ?? "(untitled)";
	const status = asString(issue.status) ?? "unknown";
	const priority =
		typeof issue.priority === "number" && Number.isFinite(issue.priority) ? String(Math.trunc(issue.priority)) : "?";
	const issueType = asString(issue.issue_type) ?? "unknown";
	const assignee = asString(issue.assignee) ?? "(none)";
	const labels = Array.isArray(issue.labels)
		? issue.labels.filter(label => typeof label === "string" && label.trim()).join(", ")
		: "";

	lines.push(`${id}: ${title}`);
	lines.push(`status=${status} priority=${priority} type=${issueType} assignee=${assignee}`);
	if (labels) lines.push(`labels: ${labels}`);

	const description = asString(issue.description) ?? "";
	const acceptance = asString(issue.acceptance_criteria) ?? "";
	lines.push("");
	lines.push("Description:");
	lines.push(description || "(none)");
	lines.push("");
	lines.push("Acceptance Criteria:");
	lines.push(acceptance || "(none)");

	if (!commentsResult.ok) {
		lines.push("");
		lines.push(`Comments: failed to load (${commentsResult.error ?? "unknown error"})`);
		return lines.join("\n");
	}

	const comments = toRecordArray(commentsResult.data);
	lines.push("");
	lines.push(`Comments (${comments.length}):`);
	if (comments.length === 0) {
		lines.push("(none)");
		return lines.join("\n");
	}

	for (const comment of comments) {
		const author = asString(comment.author) ?? "unknown";
		const createdAt = asString(comment.created_at) ?? "unknown-time";
		const text = asString(comment.text) ?? "";
		lines.push(`- ${createdAt} ${author}`);
		if (!text) {
			lines.push("  (empty)");
			continue;
		}
		for (const commentLine of text.split("\n")) {
			lines.push(`  ${commentLine}`);
		}
	}

	return lines.join("\n");
}

async function runStart(sockPath: string): Promise<string> {
	const response = await sendIpc(
		sockPath,
		{
			type: "start_tasks",
			ts: Date.now(),
		},
		30_000,
	);
	const rec = asRecord(response);
	if (rec && rec.ok === false) {
		const message = asString(rec.error) ?? asString(rec.summary) ?? "start_tasks failed";
		return `tasks start failed: ${message}`;
	}

	const spawned = typeof rec?.spawned === "number" && Number.isFinite(rec.spawned) ? Math.trunc(rec.spawned) : null;
	const taskIds =
		Array.isArray(rec?.taskIds) && rec.taskIds.every(id => typeof id === "string") ? (rec.taskIds as string[]) : [];

	if (spawned === null) {
		return "Started OMS task spawning.";
	}

	if (taskIds.length === 0) {
		return `Started OMS task spawning (spawned=${spawned}).`;
	}

	return `Started OMS task spawning (spawned=${spawned}): ${taskIds.join(", ")}`;
}

async function runStop(sockPath: string, taskId: string): Promise<string> {
	const activeAgents = await getActiveAgentsForTask(sockPath, taskId);
	if (!activeAgents.ok) {
		return `tasks stop ${taskId} failed: ${activeAgents.error ?? "failed to inspect active agents"}`;
	}
	if (activeAgents.agents.length === 0) {
		return `No active agents found for task ${taskId}.`;
	}

	const response = await sendIpc(
		sockPath,
		{
			type: "interrupt_agent",
			taskId,
			message: "Stopped by user via /tasks stop",
			ts: Date.now(),
		},
		30_000,
	);
	const rec = asRecord(response);
	if (rec && rec.ok === false) {
		const message = asString(rec.error) ?? asString(rec.summary) ?? "interrupt_agent failed";
		return `tasks stop ${taskId} failed: ${message}`;
	}

	const agentList = activeAgents.agents.join(", ");
	return `Stop requested for task ${taskId}; targeted ${activeAgents.agents.length} active agent(s): ${agentList}`;
}

async function runDelete(sockPath: string, id: string): Promise<string> {
	const stopResponse = await sendIpc(
		sockPath,
		{
			type: "stop_agents_for_task",
			taskId: id,
			includeFinisher: true,
			waitForCompletion: true,
			ts: Date.now(),
		},
		30_000,
	);
	const stopRec = asRecord(stopResponse);
	if (stopRec && stopRec.ok === false) {
		const message = asString(stopRec.error) ?? asString(stopRec.summary) ?? "failed to stop agents";
		return `tasks delete ${id} failed: ${message}`;
	}

	const deleted = await sendTasksRequest(sockPath, {
		action: "delete",
		params: { id },
	});
	if (deleted.ok) {
		return `Deleted task ${id}.`;
	}

	const fallback = await sendTasksRequest(sockPath, {
		action: "close",
		params: { id, reason: DELETE_FALLBACK_REASON },
	});
	if (fallback.ok) {
		return `Delete failed for task ${id}; task was cancelled via close fallback.`;
	}

	const deleteError = deleted.error ?? "delete failed";
	const fallbackError = fallback.error ?? "close fallback failed";
	return `tasks delete ${id} failed: delete=${deleteError}; close_fallback=${fallbackError}`;
}

async function getActiveAgentsForTask(
	sockPath: string,
	taskId: string,
): Promise<{ ok: true; agents: string[] } | { ok: false; error: string | null }> {
	const response = await sendIpc(
		sockPath,
		{
			type: "list_task_agents",
			taskId,
			ts: Date.now(),
		},
		30_000,
	);
	const rec = asRecord(response);
	if (!rec || rec.ok !== true) {
		const error = asString(rec?.error) ?? asString(rec?.summary) ?? "list_task_agents failed";
		return { ok: false, error };
	}

	const agents = toRecordArray(rec.agents)
		.filter(agent => {
			const state = asString(agent.state)?.toLowerCase() ?? "";
			return !TERMINAL_AGENT_STATUSES.has(state);
		})
		.map(agent => asString(agent.id) ?? asString(agent.tasksAgentId) ?? "")
		.filter(Boolean);

	return { ok: true, agents };
}

async function sendTasksRequest(sockPath: string, payload: UnknownRecord): Promise<TasksRequestResult> {
	const actor = process.env.TASKS_ACTOR ?? "oms-singularity";
	const response = await sendIpc(
		sockPath,
		{
			type: "tasks_request",
			...payload,
			actor,
			ts: Date.now(),
		},
		30_000,
	);

	const rec = asRecord(response);
	if (!rec || rec.ok !== true) {
		const error = asString(rec?.error) ?? "tasks request failed";
		return {
			ok: false,
			data: null,
			error,
			response: rec,
		};
	}

	return {
		ok: true,
		data: rec.data ?? null,
		error: null,
		response: rec,
	};
}

function toRecordArray(value: unknown): UnknownRecord[] {
	if (!Array.isArray(value)) return [];
	const out: UnknownRecord[] = [];
	for (const item of value) {
		const rec = asRecord(item);
		if (rec) out.push(rec);
	}
	return out;
}
