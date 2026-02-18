import { makeTasksExtension } from "./tasks-tool";

export default makeTasksExtension({
	role: "singularity",
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
