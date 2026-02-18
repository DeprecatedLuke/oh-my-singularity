/**
 * Guard: block tasks tracker access and git write commands through bash.
 * Agents must use the typed `tasks` tool for tracker ops.
 */

import { asRecord, type ExtensionAPI } from "./types";

function extractCommand(args: unknown): string {
	const rec = asRecord(args);
	if (!rec) return "";
	const cmd = rec.command;
	return typeof cmd === "string" ? cmd : "";
}

const TASKS_TOKEN_RE = /(^|[\s;|&()'"`])(?:[^\s;|&()'"`]*\/)?tasks(?=$|[\s;|&()'"`])/;
const TASKS_BACKING_STORE_RE =
	/(?:\.tasks\/(?:issues|events|interactions)\.jsonl|tasks\.db|\.oms\/sessions\/[^ \t\n"'`;|&()]+\/tasks\/tasks\.json|\bOMS_TASK_STORE_DIR\b|\bOMS_FALLBACK_TASKS_DIR\b)/;

// Git write subcommands that non-singularity agents must not run.
// Read-only commands (log, diff, status, show, blame, branch) are allowed.
const GIT_WRITE_RE = /\bgit\s+(?:\S+\s+)*?(commit|add|push|stash|checkout|reset|rebase|merge|cherry-pick)\b/;

// If OMS_ROLE is set, this is a spawned (non-singularity) agent.
const isManagedAgent = !!process.env.OMS_ROLE;

export default async function tasksBashGuardExtension(api: ExtensionAPI): Promise<void> {
	api.on("tool_call", async event => {
		const toolName = typeof event?.toolName === "string" ? event.toolName : "";
		if (toolName !== "bash") return;

		const command = extractCommand(event?.input ?? event?.args).trim();
		if (!command) return;

		// Block git write commands for non-singularity agents
		if (isManagedAgent && GIT_WRITE_RE.test(command)) {
			return {
				block: true,
				reason:
					"You MUST NOT run git write commands (commit, add, push, stash, checkout, reset, rebase, merge, cherry-pick). Git operations are managed by the singularity agent.",
			};
		}

		// Block tasks tracker access via bash - agents must use the typed tasks tool
		if (isManagedAgent && (TASKS_TOKEN_RE.test(command) || TASKS_BACKING_STORE_RE.test(command))) {
			return {
				block: true,
				reason:
					"Do not access the task tracker via bash/node or parse task-store backing files directly. Use the dedicated tasks tool for issue-tracker operations.",
			};
		}
	});
}
