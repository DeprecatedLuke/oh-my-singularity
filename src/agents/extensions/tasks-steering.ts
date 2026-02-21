import { makeTasksExtension } from "./tasks-tool";

export default makeTasksExtension({
	agentType: "steering",
	allowedActions: ["show", "list", "search", "ready", "comments", "query", "dep_tree", "types"],
});
