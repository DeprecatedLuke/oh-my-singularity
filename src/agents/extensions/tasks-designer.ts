import { registerTasksWorkerHooks } from "./tasks-worker";
import type { ExtensionAPI } from "./types";

export default async function tasksDesignerExtension(api: ExtensionAPI): Promise<void> {
	await registerTasksWorkerHooks(api, "designer");
}
