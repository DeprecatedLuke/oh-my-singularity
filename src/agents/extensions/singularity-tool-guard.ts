/**
 * Guard singularity tool access.
 *
 * Singularity is a requirements analyst / coordinator.
 * It may read/explore code for context and make trivial direct edits or write small files,
 * but must not implement multi-file features.
 */

import type { ExtensionAPI } from "./types";

const ALLOWED = new Set([
	"tasks",
	"start_tasks",

	"broadcast_to_workers",
	"interrupt_agent",
	"steer_agent",
	"replace_agent",
	"delete_task_issue",
	"ask",
	"exit_plan_mode",
	// Codebase exploration + trivial direct edits.
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"lsp",
	// Analysis, research, coordination.
	"bash",
	"python",
	"calc",
	"fetch",
	"web_search",
	"task",
]);

const PIPE_MODE_BLOCKED = new Set(["ask"]);

export default async function singularityToolGuardExtension(api: ExtensionAPI): Promise<void> {
	api.on("tool_call", async event => {
		const toolName = typeof event?.toolName === "string" ? event.toolName : "";
		const pipeMode = process.env.OMS_PIPE_MODE === "1";

		if (pipeMode && PIPE_MODE_BLOCKED.has(toolName)) {
			return {
				block: true,
				reason: `Tool '${toolName}' is disabled for singularity in pipe mode. Run in interactive mode for clarifications.`,
			};
		}
		if (ALLOWED.has(toolName)) return;

		return {
			block: true,
			reason:
				`Tool '${toolName}' is disabled for singularity. ` +
				"Create a tasks issue and let issuers/workers handle implementation.",
		};
	});
}
