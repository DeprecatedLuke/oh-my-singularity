import path from "node:path";
import { ensureDirExists } from "../setup/environment";
import { Args, Command, type CommandCtor, type CommandEntry, Flags, run as runCli } from "./framework";
import {
	printTasksCommandHelp,
	runTasksMaintenanceCommand,
	TASKS_MAINTENANCE_ACTIONS,
	type TasksMaintenanceCommand,
} from "./tasks-maintenance";

export type OmsLaunchOptions = {
	pipeMode: boolean;
	pipeRequestArg: string;
	targetProjectPath: string;
};

type LaunchRunner = (opts: OmsLaunchOptions) => Promise<void>;

export function resolveOmsCliBin(argv = process.argv): string {
	const argv0 = argv[0] ?? "";
	const argv1 = argv[1] ?? "";
	const base = path.basename(argv0).toLowerCase();
	if (base.startsWith("bun") && argv1) {
		const rel = path.relative(process.cwd(), argv1);
		const script = rel && !rel.startsWith("..") ? rel : argv1;
		return `bun ${script}`;
	}
	return "oms";
}

function createLaunchCommand(runLaunch: LaunchRunner): CommandCtor {
	return class LaunchCommand extends Command {
		static hidden = true;
		static strict = false;
		static description = "Run OMS (TUI default, pipe mode with --pipe)";
		static flags = {
			pipe: Flags.boolean({
				char: "p",
				description: "Headless one-shot mode (stdin/args -> stdout)",
			}),
		};
		static args = {
			targetProjectPath: Args.string({
				description: "Target project path",
				required: false,
			}),
			request: Args.string({
				description: "Pipe request text",
				required: false,
				multiple: true,
			}),
		};

		async run(): Promise<void> {
			const { args, flags } = await this.parse(LaunchCommand);
			const pipeMode = flags.pipe === true;
			const targetArg =
				typeof args.targetProjectPath === "string" && args.targetProjectPath.trim() ? args.targetProjectPath : ".";
			const targetProjectPath = path.resolve(process.cwd(), targetArg);
			const requestArg = Array.isArray(args.request)
				? args.request.join(" ")
				: typeof args.request === "string"
					? args.request
					: "";
			await runLaunch({
				pipeMode,
				pipeRequestArg: requestArg,
				targetProjectPath,
			});
		}
	};
}

class TasksCommand extends Command {
	static strict = false;
	static description = "Manage JSON task store maintenance operations";
	static args = {
		action: Args.string({
			description: "Maintenance action",
			required: false,
			options: TASKS_MAINTENANCE_ACTIONS,
		}),
		targetProjectPath: Args.string({
			description: "Target project path",
			required: false,
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(TasksCommand);
		const action = args.action;
		if (!action) {
			printTasksCommandHelp(this.config.bin);
			return;
		}
		if (action !== "prune" && action !== "clear") {
			throw new Error(`Unknown tasks subcommand: ${String(action)}`);
		}

		const targetArg =
			typeof args.targetProjectPath === "string" && args.targetProjectPath.trim() ? args.targetProjectPath : ".";
		const targetDir = path.resolve(process.cwd(), targetArg);
		ensureDirExists(targetDir);
		await runTasksMaintenanceCommand({
			command: action as TasksMaintenanceCommand,
			targetProjectPath: targetDir,
		});
	}
}

function isCliSubcommand(commands: CommandEntry[], first: string | undefined): boolean {
	if (!first || first.startsWith("-")) return false;
	return commands.some(entry => entry.name === first || entry.aliases?.includes(first));
}

export async function runOmsCli(opts: {
	argv: string[];
	bin: string;
	version: string;
	onLaunch: LaunchRunner;
}): Promise<void> {
	const launchCommand = createLaunchCommand(opts.onLaunch);
	const commands: CommandEntry[] = [
		{ name: "launch", load: async () => launchCommand },
		{ name: "tasks", load: async () => TasksCommand },
	];

	const first = opts.argv[0];
	const tasksHelpOnly =
		first === "tasks" && (opts.argv[1] === "--help" || opts.argv[1] === "-h" || opts.argv[1] === "help");
	const runArgv = tasksHelpOnly
		? ["tasks"]
		: first === "--help" || first === "-h" || first === "--version" || first === "-v" || first === "help"
			? opts.argv
			: isCliSubcommand(commands, first)
				? opts.argv
				: ["launch", ...opts.argv];

	await runCli({
		bin: opts.bin,
		version: opts.version,
		argv: runArgv,
		commands,
	});
}
