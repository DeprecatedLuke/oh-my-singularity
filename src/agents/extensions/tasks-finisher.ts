import { registerAdvanceLifecycleTool } from "./advance-lifecycle-tool";
import { makeTasksExtension } from "./tasks-tool";
import type { ExtensionAPI } from "./types";

const registerFinisherTasksTool = makeTasksExtension({
	agentType: "finisher",
	allowedActions: [
		"show",
		"list",
		"search",
		"ready",
		"comments",
		"comment_add",
		"query",
		"dep_tree",
		"types",
		"create",
		"update",
	],
});

export default async function tasksFinisherExtension(api: ExtensionAPI): Promise<void> {
	await registerFinisherTasksTool(api);
	registerAdvanceLifecycleTool(api, "finisher");
}
