import fs from "node:fs";
import path from "node:path";
import { computeOmsSingularitySockPath } from "../setup/environment";
import { computeJsonTaskStoreDir, JsonTaskStore } from "../tasks/store";

export type TasksMaintenanceCommand = "prune" | "clear";
export const TASKS_MAINTENANCE_ACTIONS = ["prune", "clear"] as const;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"] as const;
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function readFileSizeBytes(filePath: string): number {
	try {
		return fs.statSync(filePath).size;
	} catch {
		return 0;
	}
}

export function printTasksCommandHelp(bin: string): void {
	process.stdout.write(
		[
			"Manage JSON task store maintenance operations",
			"",
			"USAGE",
			`  $ ${bin} tasks <COMMAND> [TARGETPROJECTPATH]`,
			"",
			"COMMANDS",
			"  prune   Compact/prune JSON task store artifacts",
			"  clear   Reset task store to an empty state",
			"",
		].join("\n"),
	);
}

export async function runTasksMaintenanceCommand(opts: {
	command: TasksMaintenanceCommand;
	targetProjectPath: string;
}): Promise<void> {
	const { sessionDir: omsSessionDir } = computeOmsSingularitySockPath(opts.targetProjectPath);
	const taskStoreDir = computeJsonTaskStoreDir(omsSessionDir);
	const storeFilePath = path.join(taskStoreDir, "tasks.json");
	const beforeSize = readFileSizeBytes(storeFilePath);

	if (opts.command === "clear") {
		fs.rmSync(taskStoreDir, { recursive: true, force: true });
		const tasksClient = new JsonTaskStore({
			cwd: opts.targetProjectPath,
			sessionDir: omsSessionDir,
			actor: "oms-cli",
		});
		await tasksClient.ready();
		const afterSize = readFileSizeBytes(storeFilePath);
		process.stdout.write(`Cleared task store: ${taskStoreDir}\n`);
		process.stdout.write(`Size: ${formatBytes(beforeSize)} -> ${formatBytes(afterSize)}\n`);
		return;
	}

	const tasksClient = new JsonTaskStore({
		cwd: opts.targetProjectPath,
		sessionDir: omsSessionDir,
		actor: "oms-cli",
	});
	await tasksClient.ready();
	const issues = await tasksClient.list(["--all"]);
	const taskCount = issues.filter(issue => issue.issue_type === "task").length;
	const agentCount = issues.filter(issue => issue.issue_type === "agent").length;
	const afterSize = readFileSizeBytes(storeFilePath);

	process.stdout.write(`Pruned task store: ${taskStoreDir}\n`);
	process.stdout.write(`Size: ${formatBytes(beforeSize)} -> ${formatBytes(afterSize)}\n`);
	process.stdout.write(`Issues: ${issues.length} (tasks: ${taskCount}, agents: ${agentCount})\n`);
}
