/**
 * Tasks tool extension for omp.
 *
 * Registers a single tool `tasks` with a constrained set of allowed actions.
 * The outer harness can load different extension modules per agent role to
 * enforce task permissions via tool availability.
 */
import net from "node:net";
import { getCapabilities } from "../../core/capabilities";
import { logger } from "../../utils";
import type { ExtensionAPI, UnknownRecord } from "./types";

type TasksExtensionOptions = {
	role?: string;
	allowedActions?: string[];
};

export function makeTasksExtension(opts: TasksExtensionOptions) {
	const role = opts?.role ?? "agent";
	const allowed = new Set(Array.isArray(opts?.allowedActions) ? opts.allowedActions : []);

	return async function tasksExtension(api: ExtensionAPI): Promise<void> {
		const { Type } = api.typebox;

		const tool = {
			name: "tasks",
			label: "Tasks",
			description:
				"Interact with the Tasks issue tracker. Always use this tool for issue tracker operations. Never invoke Tasks CLI via shell (`bash`, scripts, aliases, subshells). Actions are permissioned by the harness.",
			parameters: Type.Object(
				{
					action: Type.String({
						description:
							"Action to perform (e.g. show, list, search, ready, comments, comment_add, create, update, close). " +
							"Note: singularity can use close/update when explicitly requested by user.",
					}),

					// Common
					id: Type.Optional(Type.String({ description: "Issue id" })),
					limit: Type.Optional(Type.Number({ description: "Limit for list-like operations" })),

					// list/search filters
					status: Type.Optional(Type.String({ description: "Filter status for list/search" })),
					type: Type.Optional(Type.String({ description: "Filter type for list" })),
					includeClosed: Type.Optional(
						Type.Boolean({
							description: "If true, include closed issues (tasks list --all)",
						}),
					),
					includeComments: Type.Optional(
						Type.Boolean({
							description: "If true, include comments in tasks search",
						}),
					),

					// comment
					text: Type.Optional(Type.String({ description: "Comment text" })),

					// create
					title: Type.Optional(Type.String({ description: "Title for new issue" })),
					description: Type.Optional(Type.String({ description: "Description for new issue" })),
					labels: Type.Optional(Type.Array(Type.String(), { description: "Labels" })),
					priority: Type.Optional(Type.Number({ description: "Priority (0-4)" })),
					assignee: Type.Optional(Type.String({ description: "Assignee" })),
					depends_on: Type.Optional(
						Type.Union([Type.String(), Type.Array(Type.String())], {
							description: "Depends-on issue id(s) for create action",
						}),
					),

					// close
					reason: Type.Optional(Type.String({ description: "Close reason" })),

					// update
					newStatus: Type.Optional(Type.String({ description: "New status (tasks update --status)" })),
					claim: Type.Optional(
						Type.Boolean({
							description: "If true, claim the issue (tasks update --claim)",
						}),
					),

					// query / search / dep_tree / dep_add
					dependsOn: Type.Optional(Type.String({ description: "Depends-on issue id (for dep_add)" })),
					query: Type.Optional(
						Type.String({ description: "Query expression (tasks query) or text search (tasks search)" }),
					),
					direction: Type.Optional(Type.String({ description: "Dependency tree direction (down|up|both)" })),
					maxDepth: Type.Optional(Type.Number({ description: "Max dependency tree depth" })),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId: string, params: Record<string, unknown> | undefined) => {
				const action = typeof params?.action === "string" ? params.action : "";

				if (!allowed.has(action)) {
					const caps = getCapabilities(role);
					const isImplementer = caps.category === "implementer" && (action === "close" || action === "update");
					const isOrchestratorAction =
						caps.category === "orchestrator" && (action === "close" || action === "update");
					const message = isImplementer
						? `tasks: action not permitted: ${action} (role=${role}). ` +
							"Workers must exit with a concise summary; finisher handles update/close."
						: isOrchestratorAction
							? `tasks: action not permitted: ${action} (role=${role}). ` +
								"Singularity must not mutate issue lifecycle directly. Use broadcast_to_workers to coordinate, then let steering/finisher handle close/update."
							: `tasks: action not permitted: ${action} (role=${role})`;
					return {
						content: [
							{
								type: "text",
								text: message,
							},
						],
						details: { role, action, allowedActions: [...allowed] },
					};
				}

				const sockPath = process.env.OMS_SINGULARITY_SOCK ?? "";
				if (!sockPath.trim()) {
					return {
						content: [
							{ type: "text", text: "tasks: OMS socket not configured (OMS_SINGULARITY_SOCK is empty)." },
						],
						details: { role, action },
					};
				}

				const actor = process.env.TASKS_ACTOR ?? `oms-${role}`;
				const defaultTaskId =
					typeof process.env.OMS_TASK_ID === "string" && process.env.OMS_TASK_ID.trim()
						? process.env.OMS_TASK_ID.trim()
						: null;

				try {
					const response = await sendRequest(
						sockPath,
						{
							type: "tasks_request",
							action,
							params,
							actor,
							defaultTaskId,
							ts: Date.now(),
						},
						30_000,
					);

					if (!response || response.ok !== true) {
						const message =
							typeof response?.error === "string" && response.error.trim()
								? response.error.trim()
								: "tasks request failed";
						return {
							content: [{ type: "text", text: `tasks: ${message}` }],
							details: {
								role,
								action,
								error: message,
								response,
							},
						};
					}

					const payload = response.data ?? null;
					const text =
						payload === null
							? `tasks ${action}: ok (no output)`
							: `tasks ${action}: ok\n${JSON.stringify(payload, null, 2)}`;

					return {
						content: [{ type: "text", text }],
						details: payload,
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: `tasks: ${message}` }],
						details: {
							role,
							action,
							error: message,
						},
					};
				}
			},
		};

		api.registerTool(tool);
	};
}

function sendRequest(sockPath: string, payload: unknown, timeoutMs = 1500): Promise<UnknownRecord> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let responseText = "";

		const client = net.createConnection({ path: sockPath }, () => {
			client.write(`${JSON.stringify(payload)}\n`);
		});

		client.setEncoding("utf8");
		client.on("data", chunk => {
			responseText += chunk;
		});

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				client.destroy();
			} catch (err) {
				logger.debug("agents/extensions/tasks-tool.ts: best-effort failure after client.destroy();", { err });
			}
			reject(new Error(`Timeout connecting to ${sockPath}`));
		}, timeoutMs);

		client.on("error", err => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(err);
		});

		client.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);

			const trimmed = responseText.trim();
			if (!trimmed || trimmed === "ok") {
				resolve({ ok: true, data: null });
				return;
			}

			try {
				const parsed = JSON.parse(trimmed);
				resolve(toRecord(parsed, { ok: true, data: parsed }));
			} catch {
				resolve({ ok: true, data: trimmed });
			}
		});
	});
}

function toRecord(value: unknown, fallback: UnknownRecord): UnknownRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
	return value as UnknownRecord;
}
