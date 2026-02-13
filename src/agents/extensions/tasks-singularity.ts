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
		"dep_add",
		"types",
		"create",
		"update",
		"close",
	],
});
