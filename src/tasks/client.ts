import { logger } from "../utils";
import type { BatchCreateIssueInput, BatchCreateResult } from "./store/types";
import type { TaskActivityEvent, TaskComment, TaskIssue } from "./types";

export interface TaskCreateInput {
	type?: string;
	name?: string;
	labels?: string[];
	assignee?: string | null;
	depends_on?: string | string[];
	references?: string | string[];
}

export interface TaskSearchInput {
	status?: string | null;
	limit?: number;
}

export interface TaskDepTreeInput {
	direction?: string;
	status?: string;
	maxDepth?: number;
}

export interface TaskUpdateInput {
	status?: string;
	newStatus?: string;
	claim?: boolean;
	labels?: string[];
	priority?: number;
	assignee?: string | null;
	references?: string | string[];
}

export interface TaskStoreEvent {
	type: "issues-changed" | "ready-changed" | "activity";
	issues?: TaskIssue[];
	ready?: TaskIssue[];
	activity?: TaskActivityEvent[];
}

export interface TaskStoreClient {
	readonly workingDir: string;
	ready(): Promise<TaskIssue[]>;
	list(args?: readonly string[]): Promise<TaskIssue[]>;
	show(id: string): Promise<TaskIssue>;
	create(title: string, description?: string | null, priority?: number, options?: TaskCreateInput): Promise<TaskIssue>;
	createBatch?(inputs: BatchCreateIssueInput[]): Promise<BatchCreateResult>;
	update(id: string, patch: TaskUpdateInput): Promise<unknown>;
	close(id: string, reason?: string): Promise<unknown>;
	search(query: string, options?: TaskSearchInput): Promise<TaskIssue[]>;
	claim(id: string): Promise<unknown>;
	updateStatus(id: string, status: string): Promise<unknown>;
	addLabel(id: string, label: string): Promise<unknown>;
	comment(id: string, text: string, actor?: string): Promise<unknown>;
	comments(id: string): Promise<TaskComment[]>;
	createAgent(name: string): Promise<string>;
	setAgentState(id: string, state: string): Promise<unknown>;
	heartbeat(id: string): Promise<unknown>;
	setSlot(agentId: string, slot: string, taskId: string): Promise<unknown>;
	clearSlot(agentId: string, slot: string): Promise<unknown>;
	query(expr: string, args?: readonly string[]): Promise<TaskIssue[]>;
	depTree(id: string, options?: TaskDepTreeInput): Promise<unknown>;
	depAdd(issueId: string, dependsOnId: string): Promise<unknown>;
	types(): Promise<string[]>;
	delete(id: string): Promise<unknown>;
	activity(options?: { limit?: number }): Promise<TaskActivityEvent[]>;
	readAgentMessages?(agentId: string, limit?: number): Promise<unknown[]>;
	recordAgentEvent?(agentId: string, event: unknown, taskId?: string | null): Promise<unknown>;
	recordAgentUsage?(
		agentId: string,
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
			cost: number;
		},
		taskId?: string | null,
	): Promise<unknown>;
	subscribe?(listener: (event: TaskStoreEvent) => void): () => void;
}

export interface TaskClientOptions {
	cwd: string;
	/**
	 * Actor name for audit trail.
	 * If omitted, TaskClient will use $TASKS_ACTOR if set, otherwise "oh-my-singularity".
	 */
	actor?: string;
	/** Path to tasks CLI binary (default: "tasks"). */
	tasksCli?: string;

	/** Suppress non-essential output from tasks (recommended for JSON parsing). Default: true. */
	quiet?: boolean;
}

export class TaskCliError extends Error {
	readonly cmd: string[];
	readonly cwd: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;

	constructor(opts: {
		message: string;
		cmd: string[];
		cwd: string;
		exitCode: number;
		stdout: string;
		stderr: string;
	}) {
		super(opts.message);
		this.name = "TaskCliError";

		this.cmd = opts.cmd;
		this.cwd = opts.cwd;
		this.exitCode = opts.exitCode;
		this.stdout = opts.stdout;
		this.stderr = opts.stderr;
	}
}

function formatCmd(cmd: readonly string[]): string {
	return cmd
		.map(part => {
			if (part === "") return '""';
			if (/[^A-Za-z0-9_\-./:=]/.test(part)) return JSON.stringify(part);
			return part;
		})
		.join(" ");
}

async function streamToText(stream: ReadableStream | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return await new Response(stream).text();
}

export class TaskClient implements TaskStoreClient {
	private readonly cwd: string;
	private readonly actor: string;
	private readonly tasksCli: string;
	private readonly quiet: boolean;

	constructor(options: TaskClientOptions) {
		this.cwd = options.cwd;
		this.actor = options.actor ?? process.env.TASKS_ACTOR ?? "oh-my-singularity";
		this.tasksCli = options.tasksCli ?? "tasks";
		this.quiet = options.quiet ?? true;
	}

	get workingDir(): string {
		return this.cwd;
	}

	private buildCmd(args: readonly string[], actor?: string): string[] {
		return [this.tasksCli, ...(this.quiet ? ["--quiet"] : []), "--actor", actor?.trim() || this.actor, ...args];
	}

	private async run(args: readonly string[], actor?: string): Promise<{ stdout: string; stderr: string }> {
		const cmd = this.buildCmd(args, actor);

		let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			proc = Bun.spawn({
				cmd,
				cwd: this.cwd,
				stdout: "pipe",
				stderr: "pipe",
				stdin: "ignore",
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error while spawning tasks process";
			throw new Error(
				`Failed to spawn tasks CLI (${this.tasksCli}). Is it installed and in PATH?\n` +
					`cwd: ${this.cwd}\n` +
					`cmd: ${formatCmd(cmd)}\n` +
					`error: ${message}`,
			);
		}

		const [stdout, stderr, exitCode] = await Promise.all([
			streamToText(proc.stdout),
			streamToText(proc.stderr),
			proc.exited,
		]);

		if (exitCode !== 0) {
			const detail = stderr.trim() || stdout.trim();
			throw new TaskCliError({
				message: `tasks command failed (exit ${exitCode}): ${formatCmd(cmd)}${detail ? `\n${detail}` : ""}`,
				cmd,
				cwd: this.cwd,
				exitCode,
				stdout,
				stderr,
			});
		}

		return { stdout, stderr };
	}

	private async runJson<T>(args: readonly string[], actor?: string): Promise<T> {
		const { stdout } = await this.run([...args, "--json"], actor);
		const text = stdout.trim();
		if (!text) {
			// Some commands may succeed but print nothing in JSON mode.
			return undefined as T;
		}

		try {
			return JSON.parse(text) as T;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Failed to parse tasks JSON output.\n` +
					`cmd: ${formatCmd(this.buildCmd([...args, "--json"], actor))}\n` +
					`error: ${message}\n` +
					`stdout (first 500 chars): ${text.slice(0, 500)}`,
			);
		}
	}

	async ready(): Promise<TaskIssue[]> {
		return await this.runJson<TaskIssue[]>(["ready"]);
	}

	async list(args?: readonly string[]): Promise<TaskIssue[]> {
		return await this.runJson<TaskIssue[]>(["list", ...(args ?? [])]);
	}

	async show(id: string): Promise<TaskIssue> {
		const data = await this.runJson<unknown>(["show", id]);

		if (Array.isArray(data)) {
			const first = data[0];
			if (first && typeof first === "object") return first as TaskIssue;
		}

		if (data && typeof data === "object") return data as TaskIssue;

		throw new Error(
			`tasks show returned unexpected JSON shape for id ${id}.\n` + `cwd: ${this.cwd}\n` + `type: ${typeof data}`,
		);
	}

	async create(
		title: string,
		description?: string | null,
		priority?: number,
		options?: TaskCreateInput,
	): Promise<TaskIssue> {
		const issueType = options?.type?.trim() || "task";
		const args = ["create", title, "--type", issueType, "--silent"];
		if (options?.name?.trim()) args.push("--name", options.name.trim());
		if (description?.trim()) args.push("--description", description.trim());
		if (typeof priority === "number" && Number.isFinite(priority)) {
			args.push("--priority", String(Math.max(0, Math.min(4, Math.trunc(priority)))));
		}
		if (Array.isArray(options?.labels)) {
			const labels = options.labels.map(label => label.trim()).filter(Boolean);
			if (labels.length > 0) args.push("--labels", labels.join(","));
		}
		if (typeof options?.depends_on === "string") {
			const dependencyId = options.depends_on.trim();
			if (dependencyId) args.push("--depends-on", dependencyId);
		} else if (Array.isArray(options?.depends_on)) {
			const dependencyIds = new Set<string>();
			for (const dependency of options.depends_on) {
				if (typeof dependency !== "string") continue;
				const dependencyId = dependency.trim();
				if (!dependencyId || dependencyIds.has(dependencyId)) continue;
				dependencyIds.add(dependencyId);
				args.push("--depends-on", dependencyId);
			}
		}
		if (typeof options?.references === "string") {
			const referenceId = options.references.trim();
			if (referenceId) args.push("--references", referenceId);
		} else if (Array.isArray(options?.references)) {
			const referenceIds = new Set<string>();
			for (const reference of options.references) {
				if (typeof reference !== "string") continue;
				const referenceId = reference.trim();
				if (!referenceId || referenceIds.has(referenceId)) continue;
				referenceIds.add(referenceId);
				args.push("--references", referenceId);
			}
		}
		const { stdout } = await this.run(args);
		const id = stdout.trim();
		if (!id) {
			throw new Error(`tasks create produced no id output.\ncwd: ${this.cwd}\nactor: ${this.actor}`);
		}
		const created = await this.show(id);
		if (typeof options?.assignee === "string" && options.assignee.trim()) {
			await this.update(id, { assignee: options.assignee.trim() });
			return await this.show(id);
		}
		return created;
	}

	async update(id: string, patch: TaskUpdateInput): Promise<unknown> {
		const args = ["update", id];
		if (patch.claim === true) args.push("--claim");
		const nextStatus = patch.newStatus?.trim() || patch.status?.trim();
		if (nextStatus) args.push("--status", nextStatus);
		if (typeof patch.priority === "number" && Number.isFinite(patch.priority)) {
			args.push("--priority", String(Math.max(0, Math.min(4, Math.trunc(patch.priority)))));
		}
		if (patch.assignee === null) {
			args.push("--unassign");
		} else if (typeof patch.assignee === "string" && patch.assignee.trim()) {
			args.push("--assignee", patch.assignee.trim());
		}
		if (Array.isArray(patch.labels)) {
			const labels = patch.labels.map(label => label.trim()).filter(Boolean);
			if (labels.length > 0) args.push("--labels", labels.join(","));
		}
		if (typeof patch.references === "string") {
			const referenceId = patch.references.trim();
			if (referenceId) args.push("--references", referenceId);
		} else if (Array.isArray(patch.references)) {
			const referenceIds = new Set<string>();
			for (const reference of patch.references) {
				if (typeof reference !== "string") continue;
				const referenceId = reference.trim();
				if (!referenceId || referenceIds.has(referenceId)) continue;
				referenceIds.add(referenceId);
				args.push("--references", referenceId);
			}
		}
		if (args.length === 2) return null;
		return await this.runJson<unknown>(args);
	}

	async search(query: string, options?: TaskSearchInput): Promise<TaskIssue[]> {
		const args = ["search", query];
		if (typeof options?.status === "string" && options.status.trim()) {
			args.push("--status", options.status.trim());
		}
		if (typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0) {
			args.push("--limit", String(Math.trunc(options.limit)));
		}
		return await this.runJson<TaskIssue[]>(args);
	}

	async claim(id: string): Promise<unknown> {
		return await this.runJson<unknown>(["update", id, "--claim", "--status", "in_progress"]);
	}

	async updateStatus(id: string, status: string): Promise<unknown> {
		return await this.runJson<unknown>(["update", id, "--status", status]);
	}

	async addLabel(id: string, label: string): Promise<unknown> {
		return await this.runJson<unknown>(["label", "add", id, label]);
	}

	async close(id: string, reason?: string): Promise<unknown> {
		const args = ["close", id];
		if (reason?.trim()) args.push("--reason", reason);
		return await this.runJson<unknown>(args);
	}

	async comment(id: string, text: string, actor?: string): Promise<unknown> {
		return await this.runJson<unknown>(["comments", "add", id, text], actor);
	}

	async comments(id: string): Promise<TaskComment[]> {
		return await this.runJson<TaskComment[]>(["comments", id]);
	}

	async createAgent(name: string): Promise<string> {
		const partsFromErr = (err: unknown): string => {
			if (err instanceof TaskCliError) {
				return [err.message, err.stderr, err.stdout].filter(Boolean).join("\n");
			}
			if (err instanceof Error) return err.message ?? String(err);
			return String(err);
		};

		const ensureAgentCustomType = async (): Promise<void> => {
			const cfg = await this.runJson<unknown>(["config", "get", "types.custom"]);
			const current =
				cfg && typeof cfg === "object" && !Array.isArray(cfg) ? (cfg as { value?: unknown }).value : "";
			const types =
				typeof current === "string"
					? current
							.split(",")
							.map(t => t.trim())
							.filter(t => t)
					: [];
			if (!types.includes("agent")) types.push("agent");
			await this.runJson<unknown>(["config", "set", "types.custom", types.join(",")]);
		};

		const createNative = async (): Promise<string> => {
			const { stdout } = await this.run(["create", name, "--type", "agent", "--labels", "gt:agent", "--silent"]);
			const id = stdout.trim();
			if (!id) {
				throw new Error(`tasks create agent produced no id output.\ncwd: ${this.cwd}\nactor: ${this.actor}`);
			}
			// Ensure the agent label for `tasks agent state/heartbeat` commands.
			try {
				await this.addLabel(id, "gt:agent");
			} catch (err) {
				logger.debug('tasks/client.ts: best-effort failure after await this.addLabel(id, "gt:agent");', { err });
			}

			return id;
		};

		// 1) Native agent task type (if enabled)
		try {
			return await createNative();
		} catch (err) {
			const text = partsFromErr(err).toLowerCase();
			if (!text.includes("invalid issue type: agent")) throw err;
		}

		// 2) Self-heal common config issue: enable `agent` as a custom type and retry.
		try {
			await ensureAgentCustomType();
			return await createNative();
		} catch (err) {
			logger.debug("tasks/client.ts: best-effort failure after return await createNative();", { err });
		}

		// 3) Fallback: create a normal task and label it as an agent.
		// Slot commands won't work without a true `type=agent`, but agent state + heartbeat will.
		const { stdout } = await this.run(["create", name, "--type", "chore", "--labels", "gt:agent", "--silent"]);
		const id = stdout.trim();
		if (!id) {
			throw new Error(`tasks create agent fallback produced no id output.\ncwd: ${this.cwd}\nactor: ${this.actor}`);
		}
		return id;
	}

	async setAgentState(id: string, state: string): Promise<unknown> {
		return await this.runJson<unknown>(["agent", "state", id, state]);
	}

	async heartbeat(id: string): Promise<unknown> {
		return await this.runJson<unknown>(["agent", "heartbeat", id]);
	}

	async setSlot(agentId: string, slot: string, taskId: string): Promise<unknown> {
		try {
			return await this.runJson<unknown>(["slot", "set", agentId, slot, taskId]);
		} catch (err) {
			const text =
				err instanceof TaskCliError
					? [err.message, err.stderr, err.stdout].filter(Boolean).join("\n")
					: err instanceof Error
						? err.message
						: String(err);
			// Slot APIs require a true agent task type; treat missing support as optional.
			if (text.toLowerCase().includes("not an agent task")) {
				return null;
			}
			throw err;
		}
	}

	async clearSlot(agentId: string, slot: string): Promise<unknown> {
		try {
			return await this.runJson<unknown>(["slot", "clear", agentId, slot]);
		} catch (err) {
			const text =
				err instanceof TaskCliError
					? [err.message, err.stderr, err.stdout].filter(Boolean).join("\n")
					: err instanceof Error
						? err.message
						: String(err);
			if (text.toLowerCase().includes("not an agent task")) {
				return null;
			}
			throw err;
		}
	}

	async query(expr: string, args?: readonly string[]): Promise<TaskIssue[]> {
		return await this.runJson<TaskIssue[]>(["query", expr, ...(args ?? [])]);
	}

	async depTree(id: string, options?: TaskDepTreeInput): Promise<unknown> {
		const args = ["dep", "tree", id];
		if (typeof options?.direction === "string" && options.direction.trim())
			args.push("--direction", options.direction.trim());
		if (typeof options?.status === "string" && options.status.trim()) args.push("--status", options.status.trim());
		if (typeof options?.maxDepth === "number" && Number.isFinite(options.maxDepth) && options.maxDepth > 0) {
			args.push("--max-depth", String(Math.trunc(options.maxDepth)));
		}
		return await this.runJson<unknown>(args);
	}

	async depAdd(issueId: string, dependsOnId: string): Promise<unknown> {
		return await this.runJson<unknown>(["dep", "add", issueId, dependsOnId]);
	}

	async types(): Promise<string[]> {
		return await this.runJson<string[]>(["types"]);
	}

	async delete(id: string): Promise<unknown> {
		return await this.runJson<unknown>(["delete", id]);
	}

	async activity(options?: { limit?: number }): Promise<TaskActivityEvent[]> {
		const args = ["activity"];
		if (options?.limit != null) args.push("--limit", String(options.limit));
		return await this.runJson<TaskActivityEvent[]>(args);
	}
}
