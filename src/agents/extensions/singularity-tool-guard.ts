/**
 * Guard singularity tool access in non-interactive pipe mode.
 */

import type { ExtensionAPI } from "./types";

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
	});
}
