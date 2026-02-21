import { makeTasksExtension } from "./tasks-tool";

export default makeTasksExtension({
	agentType: "singularity",
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
		"close",
	],
});
