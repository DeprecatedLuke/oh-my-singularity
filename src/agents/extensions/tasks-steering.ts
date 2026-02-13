import { makeTasksExtension } from "./tasks-tool";

export default makeTasksExtension({
	role: "steering",
	allowedActions: ["show", "list", "search", "ready", "comments", "query", "dep_tree", "types"],
});
