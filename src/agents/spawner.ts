import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, FINISHER_TOOLS, ISSUER_TOOLS, type OmsConfig, STEERING_TOOLS, WORKER_TOOLS } from "../config";
import { AGENT_EXTENSION_FILENAMES } from "../config/constants";
import type { TaskStoreClient } from "../tasks/client";
import { logger } from "../utils";
import type { AgentRegistry } from "./registry";
import { OmsRpcClient } from "./rpc-wrapper";
import { type AgentInfo, type AgentRole, createEmptyAgentUsage } from "./types";

function getImportMetaDir(): string {
	const maybe = (import.meta as unknown as { dir?: unknown }).dir;
	if (typeof maybe === "string" && maybe.trim()) return maybe;
	return path.dirname(fileURLToPath(import.meta.url));
}

function normalizeTools(tools: unknown, fallback: string, opts?: { stripAsk?: boolean; stripBash?: boolean }): string {
	const stripAsk = opts?.stripAsk ?? true;
	const stripBash = opts?.stripBash ?? false;

	const raw = typeof tools === "string" ? tools : "";
	const base = raw.trim() ? raw : fallback;

	const parts = base
		.split(",")
		.map(t => t.trim())
		.filter(t => t)
		.filter(t => (stripAsk ? t !== "ask" : true))
		.filter(t => (stripBash ? t !== "bash" : true));

	return parts.join(",");
}
function buildEnv(extra: Record<string, string | undefined>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries({ ...process.env, ...extra })) {
		if (typeof v === "string") env[k] = v;
	}
	return env;
}

function buildTaskPrompt(opts: {
	role: AgentRole;
	task: {
		id: string;
		title: string;
		description: string | null;
		acceptance: string | null;
		issueType?: string | null;
		labels?: string[] | null;
	};
	extra?: string;
}): string {
	const { task } = opts;
	const labels = Array.isArray(task.labels) ? task.labels : [];
	const lines: string[] = [];

	lines.push(`Task ID: ${task.id}`);
	lines.push(`Title: ${task.title}`);
	if (typeof task.issueType === "string" && task.issueType.trim()) lines.push(`Type: ${task.issueType.trim()}`);

	if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);

	lines.push("\nDescription:");
	lines.push(task.description?.trim() ? task.description.trim() : "(none)");

	if (task.acceptance?.trim()) {
		lines.push("\nAcceptance Criteria:");
		lines.push(task.acceptance.trim());
	}

	if (opts.extra?.trim()) {
		lines.push("\n---\n");
		lines.push(opts.extra.trim());
	}

	return lines.join("\n");
}

function isActiveStatus(status: AgentInfo["status"]): boolean {
	return !(
		status === "done" ||
		status === "failed" ||
		status === "aborted" ||
		status === "stopped" ||
		status === "dead"
	);
}

type SpawnGuardRole = "worker" | "issuer" | "finisher";

type WorkerKind = "worker" | "designer-worker";

export class AgentSpawner {
	private readonly tasksClient: TaskStoreClient;
	private readonly registry: AgentRegistry;
	private readonly config: OmsConfig;
	private readonly tasksAvailable: boolean;

	private readonly ipcSockPath?: string;

	private readonly promptsDir: string;
	private readonly extensionsDir: string;

	private readonly workerPromptPath: string;
	private readonly designerWorkerPromptPath: string;
	private readonly finisherPromptPath: string;
	private readonly steeringPromptPath: string;
	private readonly issuerPromptPath: string;
	private readonly broadcastSteeringPromptPath: string;
	private readonly resolverPromptPath: string;

	private readonly workerExtensionPath: string;
	private readonly designerWorkerExtensionPath: string;
	private readonly finisherExtensionPath: string;
	private readonly steeringExtensionPath: string;
	private readonly issuerExtensionPath: string;
	private readonly broadcastExtensionPath: string;
	private readonly complainExtensionPath: string;
	private readonly waitForAgentExtensionPath: string;
	private readonly readMessageHistoryExtensionPath: string;
	private readonly readTaskMessageHistoryExtensionPath: string;
	private readonly steerAgentExtensionPath: string;
	private readonly steeringReplaceAgentExtensionPath: string;
	private readonly tasksBashGuardExtensionPath: string;
	private readonly ompCrashLoggerExtensionPath: string;
	private readonly spawnInFlight = new Map<string, Promise<AgentInfo>>();

	private buildExtensionPath(filename: string): string {
		return path.resolve(this.extensionsDir, filename);
	}

	constructor(opts: {
		tasksClient: TaskStoreClient;
		registry: AgentRegistry;
		config?: OmsConfig;
		ipcSockPath?: string;
		tasksAvailable?: boolean;
	}) {
		this.tasksClient = opts.tasksClient;
		this.registry = opts.registry;
		this.config = opts.config ?? DEFAULT_CONFIG;
		this.ipcSockPath = opts.ipcSockPath;
		this.tasksAvailable = opts.tasksAvailable ?? true;

		const baseDir = getImportMetaDir();
		this.promptsDir = path.resolve(baseDir, "prompts");
		this.extensionsDir = path.resolve(baseDir, "extensions");

		this.workerPromptPath = path.resolve(this.promptsDir, "worker.md");
		this.designerWorkerPromptPath = path.resolve(this.promptsDir, "designer-worker.md");
		this.finisherPromptPath = path.resolve(this.promptsDir, "finisher.md");
		this.steeringPromptPath = path.resolve(this.promptsDir, "steering.md");
		this.issuerPromptPath = path.resolve(this.promptsDir, "issuer.md");
		this.broadcastSteeringPromptPath = path.resolve(this.promptsDir, "broadcast-steering.md");
		this.resolverPromptPath = path.resolve(this.promptsDir, "resolver.md");

		this.workerExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.worker);
		this.designerWorkerExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.designerWorker);
		this.finisherExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.finisher);
		this.steeringExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.steering);
		this.issuerExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.issuer);
		this.broadcastExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.broadcast);
		this.complainExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.complain);
		this.waitForAgentExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.waitForAgent);
		this.readMessageHistoryExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.readMessageHistory);
		this.readTaskMessageHistoryExtensionPath = this.buildExtensionPath(
			AGENT_EXTENSION_FILENAMES.readTaskMessageHistory,
		);
		this.steerAgentExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.steerAgent);
		this.steeringReplaceAgentExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.steeringReplaceAgent);
		this.tasksBashGuardExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.tasksBashGuard);
		this.ompCrashLoggerExtensionPath = this.buildExtensionPath(AGENT_EXTENSION_FILENAMES.ompCrashLogger);
	}

	isTasksAvailable(): boolean {
		return this.tasksAvailable;
	}

	private spawnGuardKey(role: SpawnGuardRole, taskId: string): string {
		return `${role}:${taskId}`;
	}

	private getActiveSpawnMatch(role: SpawnGuardRole, taskId: string): AgentInfo | null {
		const active = this.registry.getByTask(taskId).filter(agent => isActiveStatus(agent.status));

		if (role === "worker") {
			return active.find(agent => agent.role === "worker" || agent.role === "designer-worker") ?? null;
		}

		return active.find(agent => agent.role === role) ?? null;
	}

	private async withSpawnGuard(
		role: SpawnGuardRole,
		taskId: string,
		spawn: () => Promise<AgentInfo>,
	): Promise<AgentInfo> {
		const existing = this.getActiveSpawnMatch(role, taskId);
		if (existing) return existing;

		const key = this.spawnGuardKey(role, taskId);
		const inFlight = this.spawnInFlight.get(key);
		if (inFlight) return await inFlight;

		const guarded = (async () => {
			const active = this.getActiveSpawnMatch(role, taskId);
			if (active) return active;
			return await spawn();
		})();

		this.spawnInFlight.set(key, guarded);

		try {
			return await guarded;
		} finally {
			const current = this.spawnInFlight.get(key);
			if (current === guarded) this.spawnInFlight.delete(key);
		}
	}

	private getAgentSessionId(rpc: OmsRpcClient): string | undefined {
		const sessionId = rpc.getSessionId();
		return typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined;
	}

	async spawnWorker(taskId: string, opts?: { claim?: boolean; kickoffMessage?: string }): Promise<AgentInfo> {
		return await this.withSpawnGuard("worker", taskId, async () => {
			return await this.spawnImplementationWorker("worker", taskId, opts);
		});
	}

	async spawnDesignerWorker(taskId: string, opts?: { claim?: boolean; kickoffMessage?: string }): Promise<AgentInfo> {
		return await this.withSpawnGuard("worker", taskId, async () => {
			return await this.spawnImplementationWorker("designer-worker", taskId, opts);
		});
	}

	private async spawnImplementationWorker(
		kind: WorkerKind,
		taskId: string,
		opts?: { claim?: boolean; kickoffMessage?: string },
	): Promise<AgentInfo> {
		const spawnedAt = Date.now();
		let tasksAgentId: string | null = null;
		let rpc: OmsRpcClient | null = null;

		try {
			if (opts?.claim !== false) {
				await this.tasksClient.claim(taskId);
			} else {
				// claim:false means caller already owns this task (resume path).
				// Re-check status to guard against races where the task was
				// blocked/closed between scheduler snapshot and worker spawn.
				const current = await this.tasksClient.show(taskId);
				const status = (typeof current.status === "string" ? current.status : "").toLowerCase();
				if (status === "blocked" || status === "closed" || status === "deferred") {
					throw new Error(`Task ${taskId} status is '${status}'; refusing to spawn ${kind}`);
				}
			}

			tasksAgentId = await this.tasksClient.createAgent(`${kind}-${taskId}`);
			await this.tasksClient.setAgentState(tasksAgentId, "spawning");
			const agentId = `${kind}:${taskId}:${tasksAgentId}`;

			const roleCfg = this.config.roles[kind];
			const toolsBase = normalizeTools(roleCfg.tools ?? WORKER_TOOLS, WORKER_TOOLS, {
				stripBash: false,
			});
			const tools = toolsBase;

			const extensionPath = kind === "designer-worker" ? this.designerWorkerExtensionPath : this.workerExtensionPath;
			const promptPath = kind === "designer-worker" ? this.designerWorkerPromptPath : this.workerPromptPath;

			const args: string[] = [
				"--thinking",
				roleCfg.thinking,
				...(roleCfg.model ? ["--model", roleCfg.model] : []),
				"--no-pty",
				"--extension",
				this.ompCrashLoggerExtensionPath,
				"--extension",
				extensionPath,
				"--extension",
				this.tasksBashGuardExtensionPath,
				"--extension",
				this.broadcastExtensionPath,
				"--extension",
				this.complainExtensionPath,
				"--extension",
				this.waitForAgentExtensionPath,
				"--tools",
				tools,
				"--append-system-prompt",
				promptPath,
			];

			rpc = new OmsRpcClient({
				ompCli: this.config.ompCli,
				cwd: this.tasksClient.workingDir,
				env: buildEnv({
					TASKS_ACTOR: `oms-${kind}`,
					OMS_ROLE: kind,
					OMS_TASK_ID: taskId,
					OMS_AGENT_ID: agentId,
					OMS_SINGULARITY_SOCK: this.ipcSockPath,
				}),
				args,
			});

			rpc.start();

			const task = await this.tasksClient.show(taskId);
			await rpc.prompt(
				buildTaskPrompt({
					role: kind,
					task: {
						id: task.id,
						title: task.title,
						description: task.description,
						acceptance: task.acceptance_criteria,
						issueType: task.issue_type,
						labels: task.labels,
					},
					extra: opts?.kickoffMessage?.trim()
						? `## Implementation Guidance\n\n${opts.kickoffMessage.trim()}`
						: undefined,
				}),
			);

			await this.tasksClient.setSlot(tasksAgentId, "hook", taskId);
			await this.tasksClient.setAgentState(tasksAgentId, "working");

			const info: AgentInfo = {
				id: agentId,
				role: kind,
				taskId,
				tasksAgentId,
				status: "working",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt,
				lastActivity: Date.now(),
				rpc,
				model: roleCfg.model,
				thinking: roleCfg.thinking,
				sessionId: this.getAgentSessionId(rpc),
			};

			this.registry.register(info);
			return info;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);

			if (tasksAgentId) {
				try {
					await this.tasksClient.comment(
						taskId,
						`Failed to spawn ${kind} RPC agent for task ${taskId}.\n` +
							`tasksAgentId: ${tasksAgentId}\n` +
							`error: ${message}`,
					);
				} catch (err) {
					logger.debug("agents/spawner.ts: failed to record spawn-failure comment (non-fatal)", { err });
				}

				try {
					await this.tasksClient.setAgentState(tasksAgentId, "failed");
				} catch (err) {
					logger.debug(
						'agents/spawner.ts: best-effort failure after await this.tasksClient.setAgentState(tasksAgentId, "failed");',
						{ err },
					);
				}

				try {
					await this.tasksClient.close(tasksAgentId, "spawn failed");
				} catch (err) {
					logger.debug(
						'agents/spawner.ts: best-effort failure after await this.tasksClient.close(tasksAgentId, "spawn failed");',
						{ err },
					);
				}
			}

			if (rpc) {
				try {
					await rpc.stop();
				} catch (err) {
					logger.debug("agents/spawner.ts: best-effort failure after await rpc.stop();", { err });
				}
			}

			throw err;
		}
	}

	async spawnFinisher(taskId: string, workerOutput: string): Promise<AgentInfo> {
		return await this.withSpawnGuard("finisher", taskId, async () => {
			return await this.spawnFinisherInternal(taskId, workerOutput);
		});
	}
	private async spawnFinisherInternal(taskId: string, workerOutput: string): Promise<AgentInfo> {
		const spawnedAt = Date.now();
		const tasksAgentId = await this.tasksClient.createAgent(`finisher-${taskId}`);
		await this.tasksClient.setAgentState(tasksAgentId, "spawning");
		const agentId = `finisher:${taskId}:${tasksAgentId}`;
		const roleCfg = this.config.roles.finisher;
		const toolsBase = normalizeTools(roleCfg.tools ?? FINISHER_TOOLS, FINISHER_TOOLS);
		const tools = toolsBase;
		const args: string[] = [
			"--thinking",
			roleCfg.thinking,
			...(roleCfg.model ? ["--model", roleCfg.model] : []),
			"--no-pty",
			"--extension",
			this.ompCrashLoggerExtensionPath,
			"--extension",
			this.finisherExtensionPath,
			"--extension",
			this.tasksBashGuardExtensionPath,
			"--extension",
			this.broadcastExtensionPath,
			"--tools",
			tools,
			"--append-system-prompt",
			this.finisherPromptPath,
		];
		const rpc = new OmsRpcClient({
			ompCli: this.config.ompCli,
			cwd: this.tasksClient.workingDir,
			env: buildEnv({
				TASKS_ACTOR: "oms-finisher",
				OMS_ROLE: "finisher",
				OMS_TASK_ID: taskId,
				OMS_AGENT_ID: agentId,
				OMS_SINGULARITY_SOCK: this.ipcSockPath,
			}),
			args,
		});

		try {
			rpc.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.tasksClient.comment(
				taskId,
				`Failed to spawn finisher RPC agent for task ${taskId}.\n` +
					`tasksAgentId: ${tasksAgentId}\n` +
					`error: ${message}`,
			);
			await this.tasksClient.setAgentState(tasksAgentId, "failed");
			throw err;
		}

		const task = await this.tasksClient.show(taskId);
		const finisherExtra = `Implementation output:\n\n${workerOutput?.trim() ? workerOutput.trim() : "(none)"}`;
		await rpc.prompt(
			buildTaskPrompt({
				role: "finisher",
				task: {
					id: task.id,
					title: task.title,
					description: task.description,
					acceptance: task.acceptance_criteria,
					issueType: task.issue_type,
					labels: task.labels,
				},
				extra: finisherExtra,
			}),
		);
		await this.tasksClient.setSlot(tasksAgentId, "hook", taskId);
		await this.tasksClient.setAgentState(tasksAgentId, "working");
		const info: AgentInfo = {
			id: agentId,
			role: "finisher",
			taskId,
			tasksAgentId,
			status: "working",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt,
			lastActivity: Date.now(),
			rpc,
			model: roleCfg.model,
			thinking: roleCfg.thinking,
			sessionId: this.getAgentSessionId(rpc),
		};
		this.registry.register(info);
		return info;
	}

	// Legacy compatibility
	async spawnOrchestrator(taskId: string, workerOutput: string): Promise<AgentInfo> {
		return await this.spawnFinisher(taskId, workerOutput);
	}

	async spawnIssuer(taskId: string, kickoffMessage?: string): Promise<AgentInfo> {
		return await this.withSpawnGuard("issuer", taskId, async () => {
			return await this.spawnIssuerInternal(taskId, undefined, kickoffMessage);
		});
	}

	async resumeAgent(taskId: string, sessionId: string, kickoffMessage?: string): Promise<AgentInfo> {
		return await this.withSpawnGuard("issuer", taskId, async () => {
			return await this.spawnIssuerInternal(taskId, sessionId, kickoffMessage);
		});
	}

	private async spawnIssuerInternal(
		taskId: string,
		resumeSessionId?: string,
		kickoffMessage?: string,
	): Promise<AgentInfo> {
		const normalizedResumeSessionId =
			typeof resumeSessionId === "string" && resumeSessionId.trim() ? resumeSessionId.trim() : undefined;
		const spawnedAt = Date.now();
		const tasksAgentId = await this.tasksClient.createAgent(`issuer-${taskId}`);
		await this.tasksClient.setAgentState(tasksAgentId, "spawning");
		const agentId = `issuer:${taskId}:${tasksAgentId}`;
		const roleCfg = this.config.roles.issuer;
		const toolsBase = normalizeTools(roleCfg.tools ?? ISSUER_TOOLS, ISSUER_TOOLS);
		const tools = toolsBase;
		const args: string[] = [
			"--thinking",
			roleCfg.thinking,
			...(roleCfg.model ? ["--model", roleCfg.model] : []),
			"--no-pty",
			...(normalizedResumeSessionId ? ["--resume", normalizedResumeSessionId] : []),
			"--extension",
			this.ompCrashLoggerExtensionPath,
			"--extension",
			this.issuerExtensionPath,
			"--extension",
			this.tasksBashGuardExtensionPath,
			"--tools",
			tools,
			"--append-system-prompt",
			this.issuerPromptPath,
		];
		const rpc = new OmsRpcClient({
			ompCli: this.config.ompCli,
			cwd: this.tasksClient.workingDir,
			env: buildEnv({
				TASKS_ACTOR: "oms-issuer",
				OMS_ROLE: "issuer",
				OMS_TASK_ID: taskId,
				OMS_AGENT_ID: agentId,
				OMS_SINGULARITY_SOCK: this.ipcSockPath,
			}),
			args,
		});

		try {
			rpc.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const action = normalizedResumeSessionId ? "resume" : "spawn";
			await this.tasksClient.comment(
				taskId,
				`Failed to ${action} issuer RPC agent for task ${taskId}.\n` +
					`tasksAgentId: ${tasksAgentId}\n` +
					`sessionId: ${normalizedResumeSessionId ?? "(none)"}\n` +
					`error: ${message}`,
			);
			await this.tasksClient.setAgentState(tasksAgentId, "failed");
			throw err;
		}
		const task = await this.tasksClient.show(taskId);
		await rpc.prompt(
			buildTaskPrompt({
				role: "issuer",
				task: {
					id: task.id,
					title: task.title,
					description: task.description,
					acceptance: task.acceptance_criteria,
					issueType: task.issue_type,
					labels: task.labels,
				},
				extra: kickoffMessage?.trim() ? `## Kickoff Context\n\n${kickoffMessage.trim()}` : undefined,
			}),
		);
		await this.tasksClient.setSlot(tasksAgentId, "hook", taskId);
		await this.tasksClient.setAgentState(tasksAgentId, "working");
		const info: AgentInfo = {
			id: agentId,
			role: "issuer",
			taskId,
			tasksAgentId,
			status: "working",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt,
			lastActivity: Date.now(),
			rpc,
			model: roleCfg.model,
			thinking: roleCfg.thinking,
			sessionId: this.getAgentSessionId(rpc) ?? normalizedResumeSessionId,
		};
		this.registry.register(info);
		return info;
	}

	async spawnSteering(taskId: string, recentMessages: string): Promise<AgentInfo> {
		const spawnedAt = Date.now();

		const tasksAgentId = await this.tasksClient.createAgent(`steering-${taskId}`);
		await this.tasksClient.setAgentState(tasksAgentId, "spawning");
		const agentId = `steering:${taskId}:${tasksAgentId}`;

		const roleCfg = this.config.roles.steering;
		const toolsBase = normalizeTools(roleCfg.tools ?? STEERING_TOOLS, STEERING_TOOLS);
		const tools = toolsBase;

		const args: string[] = [
			"--thinking",
			roleCfg.thinking,
			...(roleCfg.model ? ["--model", roleCfg.model] : []),
			"--no-pty",
			"--extension",
			this.ompCrashLoggerExtensionPath,
			"--extension",
			this.steeringExtensionPath,
			"--extension",
			this.readTaskMessageHistoryExtensionPath,
			"--extension",
			this.steeringReplaceAgentExtensionPath,
			"--extension",
			this.tasksBashGuardExtensionPath,
			"--tools",
			tools,
			"--append-system-prompt",
			this.steeringPromptPath,
		];

		const rpc = new OmsRpcClient({
			ompCli: this.config.ompCli,
			cwd: this.tasksClient.workingDir,
			env: buildEnv({
				TASKS_ACTOR: "oms-steering",
				OMS_ROLE: "steering",
				OMS_TASK_ID: taskId,
				OMS_AGENT_ID: agentId,
				OMS_SINGULARITY_SOCK: this.ipcSockPath,
			}),
			args,
		});

		try {
			rpc.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.tasksClient.comment(
				taskId,
				`Failed to spawn steering RPC agent for task ${taskId}.\n` +
					`tasksAgentId: ${tasksAgentId}\n` +
					`error: ${message}`,
			);
			await this.tasksClient.setAgentState(tasksAgentId, "failed");
			throw err;
		}

		const task = await this.tasksClient.show(taskId);

		await rpc.prompt(
			buildTaskPrompt({
				role: "steering",
				task: {
					id: task.id,
					title: task.title,
					description: task.description,
					acceptance: task.acceptance_criteria,
					labels: task.labels,
				},
				extra:
					"Recent messages (for steering context):\n\n" +
					(recentMessages?.trim() ? recentMessages.trim() : "(none)"),
			}),
		);

		await this.tasksClient.setSlot(tasksAgentId, "hook", taskId);
		await this.tasksClient.setAgentState(tasksAgentId, "working");

		const info: AgentInfo = {
			id: agentId,
			role: "steering",
			taskId,
			tasksAgentId,
			status: "working",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt,
			lastActivity: Date.now(),
			rpc,
			model: roleCfg.model,
			thinking: roleCfg.thinking,
			sessionId: this.getAgentSessionId(rpc),
		};

		this.registry.register(info);
		return info;
	}

	async spawnResolver(opts: {
		complaintId: string;
		complainantAgentId: string;
		complainantTaskId: string;
		files: string[];
		reason: string;
		activeAgents: Array<{
			id: string;
			role: AgentRole;
			taskId: string | null;
			status: string;
			lastActivity: number;
		}>;
	}): Promise<AgentInfo> {
		const spawnedAt = Date.now();
		const complaintTag = opts.complaintId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "complaint";
		const tasksAgentId = await this.tasksClient.createAgent(`resolver-${complaintTag}`);
		await this.tasksClient.setAgentState(tasksAgentId, "spawning");
		const agentId = `steering:resolver:${opts.complaintId}:${tasksAgentId}`;
		const tools = normalizeTools(STEERING_TOOLS, STEERING_TOOLS);
		const args: string[] = [
			"--thinking",
			"medium",
			"--model",
			"sonnet",
			"--no-pty",
			"--extension",
			this.ompCrashLoggerExtensionPath,
			"--extension",
			this.readMessageHistoryExtensionPath,
			"--extension",
			this.steerAgentExtensionPath,
			"--extension",
			this.tasksBashGuardExtensionPath,
			"--tools",
			tools,
			"--append-system-prompt",
			this.resolverPromptPath,
		];
		const rpc = new OmsRpcClient({
			ompCli: this.config.ompCli,
			cwd: this.tasksClient.workingDir,
			env: buildEnv({
				TASKS_ACTOR: "oms-resolver",
				OMS_ROLE: "steering",
				OMS_TASK_ID: opts.complainantTaskId,
				OMS_AGENT_ID: agentId,
				OMS_SINGULARITY_SOCK: this.ipcSockPath,
			}),
			args,
		});

		try {
			rpc.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.tasksClient.comment(
				opts.complainantTaskId,
				`Failed to spawn resolver RPC agent for complaint ${opts.complaintId}.\n` +
					`tasksAgentId: ${tasksAgentId}\n` +
					`error: ${message}`,
			);
			await this.tasksClient.setAgentState(tasksAgentId, "failed");
			throw err;
		}

		const task = await this.tasksClient.show(opts.complainantTaskId);
		const payload = {
			complaint: {
				id: opts.complaintId,
				complainantAgentId: opts.complainantAgentId,
				complainantTaskId: opts.complainantTaskId,
				files: opts.files,
				reason: opts.reason,
			},
			activeAgents: opts.activeAgents,
		};

		await rpc.prompt(
			buildTaskPrompt({
				role: "steering",
				task: {
					id: task.id,
					title: task.title,
					description: task.description,
					acceptance: task.acceptance_criteria,
					labels: task.labels,
				},
				extra: `Conflict complaint:\n\n${JSON.stringify(payload, null, 2)}`,
			}),
		);

		await this.tasksClient.setSlot(tasksAgentId, "hook", opts.complainantTaskId);
		await this.tasksClient.setAgentState(tasksAgentId, "working");

		const info: AgentInfo = {
			id: agentId,
			role: "steering",
			taskId: opts.complainantTaskId,
			tasksAgentId,
			status: "working",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt,
			lastActivity: Date.now(),
			rpc,
			model: "sonnet",
			thinking: "medium",
			sessionId: this.getAgentSessionId(rpc),
		};

		this.registry.register(info);
		return info;
	}

	async spawnBroadcastSteering(opts: {
		message: string;
		urgency?: "normal" | "critical";
		workers: Array<{
			id: string;
			taskId: string | null;
			status: string;
			lastActivity: number;
		}>;
	}): Promise<AgentInfo> {
		const spawnedAt = Date.now();

		const tasksAgentId = await this.tasksClient.createAgent(`broadcast-steering-${spawnedAt}`);
		await this.tasksClient.setAgentState(tasksAgentId, "spawning");
		const agentId = `steering:broadcast:${tasksAgentId}`;

		const roleCfg = this.config.roles.steering;
		const toolsBase = normalizeTools(roleCfg.tools ?? STEERING_TOOLS, STEERING_TOOLS);
		const tools = toolsBase;

		const args: string[] = [
			"--thinking",
			roleCfg.thinking,
			...(roleCfg.model ? ["--model", roleCfg.model] : []),
			"--no-pty",
			"--extension",
			this.ompCrashLoggerExtensionPath,
			"--extension",
			this.steeringExtensionPath,
			"--extension",
			this.tasksBashGuardExtensionPath,
			"--tools",
			tools,
			"--append-system-prompt",
			this.broadcastSteeringPromptPath,
		];

		const rpc = new OmsRpcClient({
			ompCli: this.config.ompCli,
			cwd: this.tasksClient.workingDir,
			env: buildEnv({
				TASKS_ACTOR: "oms-broadcast-steering",
				OMS_ROLE: "steering",
				OMS_AGENT_ID: agentId,
				OMS_SINGULARITY_SOCK: this.ipcSockPath,
			}),
			args,
		});

		try {
			rpc.start();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await this.tasksClient.setAgentState(tasksAgentId, "failed");
			throw new Error(`Failed to spawn broadcast steering agent: ${message}`);
		}

		const payload = {
			broadcast: {
				message: opts.message,
				urgency: opts.urgency ?? "normal",
			},
			workers: opts.workers,
		};

		await rpc.prompt(`Broadcast request:\n\n${JSON.stringify(payload, null, 2)}`);

		await this.tasksClient.setAgentState(tasksAgentId, "working");

		const info: AgentInfo = {
			id: agentId,
			role: "steering",
			taskId: null,
			tasksAgentId,
			status: "working",
			usage: createEmptyAgentUsage(),
			events: [],
			spawnedAt,
			lastActivity: Date.now(),
			rpc,
			model: roleCfg.model,
			thinking: roleCfg.thinking,
			sessionId: this.getAgentSessionId(rpc),
		};

		this.registry.register(info);
		return info;
	}
}
