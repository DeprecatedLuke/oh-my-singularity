import { registerTasksWorkerHooks } from "./tasks-worker";
import type { ExtensionAPI } from "./types";

export default async function tasksDesignerWorkerExtension(api: ExtensionAPI): Promise<void> {
	await registerTasksWorkerHooks(api, "designer-worker");
}
