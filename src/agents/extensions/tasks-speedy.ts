import { registerAdvanceLifecycleTool } from "./advance-lifecycle-tool";
import { makeTasksExtension } from "./tasks-tool";
import type { ExtensionAPI } from "./types";

const registerSpeedyTasksTool = makeTasksExtension({
	agentType: "speedy",
	allowedActions: ["show", "list", "search", "ready", "comments", "comment_add", "query", "dep_tree", "types"],
});

export default async function tasksSpeedyExtension(api: ExtensionAPI): Promise<void> {
	await registerSpeedyTasksTool(api);
	registerAdvanceLifecycleTool(api, "speedy");
}
