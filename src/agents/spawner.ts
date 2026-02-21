import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type OmsConfig } from "../config";
import {
	AGENT_EXTENSION_FILENAMES,
	type AgentBehaviorConfig,
	getAgentSpawnConfig,
	type SpawnGuardAgent,
} from "../config/constants";
import type { ReplicaManager } from "../replica/manager";
import type { TaskStoreClient } from "../tasks/client";
import { logger } from "../utils";
import type { AgentRegistry } from "./registry";
import { OmsRpcClient } from "./rpc-wrapper";
import { type AgentInfo, type AgentType, createEmptyAgentUsage } from "./types";

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

async function formatParentTaskComments(tasksClient: TaskStoreClient, dependencyIds: string[]): Promise<string> {
	const normalizedDependencyIds = [...new Set(dependencyIds.map(dependencyId => dependencyId.trim()).filter(Boolean))];
	if (normalizedDependencyIds.length === 0) return "";

	const dependencySections = (
		await Promise.all(
			normalizedDependencyIds.map(async dependencyId => {
				try {
					const comments = await tasksClient.comments(dependencyId);
					if (!Array.isArray(comments) || comments.length === 0) return "";

					const lines: string[] = [`**Dependency: ${dependencyId}**`];
					for (const comment of comments) {
						const author =
							typeof comment.author === "string" && comment.author.trim() ? comment.author.trim() : "unknown";
						const timestamp =
							typeof comment.created_at === "string" && comment.created_at.trim()
								? comment.created_at.trim()
								: "unknown time";
						const text = typeof comment.text === "string" ? comment.text.trim() : "";
						if (!text) {
							lines.push(`- ${author} (${timestamp}):`);
							continue;
						}

						const textLines = text.replace(/\r\n?/g, "\n").split("\n");
						const [firstLine = "", ...remainingLines] = textLines;
						lines.push(`- ${author} (${timestamp}): ${firstLine}`);
						for (const line of remainingLines) {
							lines.push(`  ${line}`);
						}
					}

					return lines.join("\n");
				} catch (err) {
					logger.debug("agents/spawner.ts: failed to fetch dependency comments for prompt context (non-fatal)", {
						dependencyId,
						err,
					});
					return "";
				}
			}),
		)
	).filter(Boolean);

	if (dependencySections.length === 0) return "";
	return ["## Parent Task Context", "", ...dependencySections].join("\n\n");
}

async function formatReferencedTaskComments(tasksClient: TaskStoreClient, referenceIds: string[]): Promise<string> {
	const normalizedReferenceIds = [...new Set(referenceIds.map(referenceId => referenceId.trim()).filter(Boolean))];
	if (normalizedReferenceIds.length === 0) return "";

	const referenceSections = (
		await Promise.all(
			normalizedReferenceIds.map(async referenceId => {
				try {
					const [referencedIssue, comments] = await Promise.all([
						tasksClient.show(referenceId),
						tasksClient.comments(referenceId),
					]);

					const lines: string[] = [`**Reference: ${referenceId}**`];
					const title = typeof referencedIssue.title === "string" ? referencedIssue.title.trim() : "";
					if (title) lines.push(`Title: ${title}`);
					const description =
						typeof referencedIssue.description === "string" ? referencedIssue.description.trim() : "";
					if (description) {
						lines.push("Description:");
						for (const line of description.replace(/\r\n?/g, "\n").split("\n")) {
							lines.push(`  ${line}`);
						}
					}

					if (!Array.isArray(comments) || comments.length === 0) return lines.join("\n");
					for (const comment of comments) {
						const author =
							typeof comment.author === "string" && comment.author.trim() ? comment.author.trim() : "unknown";
						const timestamp =
							typeof comment.created_at === "string" && comment.created_at.trim()
								? comment.created_at.trim()
								: "unknown time";
						const text = typeof comment.text === "string" ? comment.text.trim() : "";
						if (!text) {
							lines.push(`- ${author} (${timestamp}):`);
							continue;
						}

						const textLines = text.replace(/\r\n?/g, "\n").split("\n");
						const [firstLine = "", ...remainingLines] = textLines;
						lines.push(`- ${author} (${timestamp}): ${firstLine}`);
						for (const line of remainingLines) {
							lines.push(`  ${line}`);
						}
					}

					return lines.join("\n");
				} catch (err) {
					logger.debug("agents/spawner.ts: failed to fetch referenced task context for prompt (non-fatal)", {
						referenceId,
						err,
					});
					return "";
				}
			}),
		)
	).filter(Boolean);

	if (referenceSections.length === 0) return "";
	return ["## Referenced Task Context", "", ...referenceSections].join("\n\n");
}

function buildTaskPrompt(opts: {
	agentType: AgentType;
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

export class AgentSpawner {
	private readonly tasksClient: TaskStoreClient;
	private readonly registry: AgentRegistry;
	private readonly config: OmsConfig;
	private readonly tasksAvailable: boolean;
	#replicaManager?: ReplicaManager;

	private readonly ipcSockPath?: string;

	private readonly promptsDir: string;
	private readonly extensionsDir: string;

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
		replicaManager?: ReplicaManager;
	}) {
		this.tasksClient = opts.tasksClient;
		this.registry = opts.registry;
		this.config = opts.config ?? DEFAULT_CONFIG;
		this.ipcSockPath = opts.ipcSockPath;
		this.tasksAvailable = opts.tasksAvailable ?? true;
		this.#replicaManager = opts.replicaManager;

		const baseDir = getImportMetaDir();
		this.promptsDir = path.resolve(baseDir, "prompts");
		this.extensionsDir = path.resolve(baseDir, "extensions");
	}

	isTasksAvailable(): boolean {
		return this.tasksAvailable;
	}

	getReplicaManager(): ReplicaManager | undefined {
		return this.#replicaManager;
	}

	private spawnGuardKey(agentType: SpawnGuardAgent, taskId: string): string {
		return `${agentType}:${taskId}`;
	}

	private getActiveSpawnMatch(agentType: SpawnGuardAgent, taskId: string): AgentInfo | null {
		const active = this.registry.getByTask(taskId).filter(agent => isActiveStatus(agent.status));

		if (agentType === "worker") {
			return (
				active.find(
					agent => agent.agentType === "worker" || agent.agentType === "speedy" || agent.agentType === "designer",
				) ?? null
			);
		}

		return active.find(agent => agent.agentType === agentType) ?? null;
	}

	#getRegisteredWorkerReplicaDir(taskId: string): string | undefined {
		const workerWithReplica = this.registry.getByTask(taskId).find(agent => {
			if (agent.agentType !== "worker" && agent.agentType !== "speedy" && agent.agentType !== "designer")
				return false;
			return typeof agent.replicaDir === "string" && agent.replicaDir.trim().length > 0;
		});
		return workerWithReplica?.replicaDir;
	}

	async #resolveFinisherReplicaDir(taskId: string): Promise<string | undefined> {
		if (!this.config.enableReplicas || !this.#replicaManager) return undefined;

		const workerReplicaDir = this.#getRegisteredWorkerReplicaDir(taskId);
		if (workerReplicaDir) return workerReplicaDir;

		try {
			const replicaExists = await this.#replicaManager.replicaExists(taskId);
			if (!replicaExists) return undefined;
			return this.#replicaManager.getReplicaDir(taskId);
		} catch (err) {
			logger.warn("agents/spawner.ts: failed to resolve finisher replica directory, falling back to root cwd", {
				taskId,
				err,
			});
			return undefined;
		}
	}

	private async withSpawnGuard(
		agentType: SpawnGuardAgent,
		taskId: string,
		spawn: () => Promise<AgentInfo>,
	): Promise<AgentInfo> {
		const existing = this.getActiveSpawnMatch(agentType, taskId);
		if (existing) return existing;

		const key = this.spawnGuardKey(agentType, taskId);
		const inFlight = this.spawnInFlight.get(key);
		if (inFlight) return await inFlight;

		const guarded = (async () => {
			const active = this.getActiveSpawnMatch(agentType, taskId);
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

	private resolveExtensionPath(key: string): string {
		const filename = (AGENT_EXTENSION_FILENAMES as Record<string, string | undefined>)[key];
		if (!filename) throw new Error(`Unknown extension key: ${key}`);
		return this.buildExtensionPath(filename);
	}

	/**
	 * Generic spawn method for all agent types.
	 *
	 * Driven by AGENT_CONFIGS — adding a new agent type means adding a config
	 * entry + prompt file, not touching this method.
	 */
	async spawnAgent(
		configKey: string,
		taskId: string | null,
		opts?: {
			claim?: boolean;
			resumeSessionId?: string;
			kickoffMessage?: string;
			/** Pre-built extra text appended to the task prompt (e.g. worker output for finisher). */
			promptExtra?: string;
			/** Async builder for extra text; receives the task. Overrides promptExtra when provided. */
			buildPromptExtra?: (task: Record<string, unknown>) => Promise<string> | string;
			/** Extra env vars merged into the agent process env. */
			extraEnv?: Record<string, string | undefined>;
			/** Custom agent ID builder. Receives tasksAgentId. */
			agentIdBuilder?: (tasksAgentId: string) => string;
			/** Override model from agent model config. */
			modelOverride?: string;
			/** Override thinking level from agent model config. */
			thinkingOverride?: string;
			/** Raw prompt text, bypasses task fetch + buildTaskPrompt. */
			rawPrompt?: string;
			/** Override agent name prefix for tasksClient.createAgent. */
			agentNamePrefix?: string;
			/** Override replicaDir in AgentInfo (e.g., merger uses worker's replica). */
			replicaDirOverride?: string;
		},
	): Promise<AgentInfo> {
		const spawnConfig = getAgentSpawnConfig(configKey);
		if (!spawnConfig) throw new Error(`No agent config for key "${configKey}"`);

		if (spawnConfig.spawnGuard != null && taskId != null) {
			return await this.withSpawnGuard(spawnConfig.spawnGuard, taskId, async () => {
				return await this.#spawnAgentInternal(configKey, taskId, spawnConfig, opts);
			});
		}

		return await this.#spawnAgentInternal(configKey, taskId, spawnConfig, opts);
	}

	async #spawnAgentInternal(
		configKey: string,
		taskId: string | null,
		spawnConfig: AgentBehaviorConfig,
		opts?: {
			claim?: boolean;
			resumeSessionId?: string;
			kickoffMessage?: string;
			promptExtra?: string;
			buildPromptExtra?: (task: Record<string, unknown>) => Promise<string> | string;
			extraEnv?: Record<string, string | undefined>;
			agentIdBuilder?: (tasksAgentId: string) => string;
			modelOverride?: string;
			thinkingOverride?: string;
			rawPrompt?: string;
			agentNamePrefix?: string;
			replicaDirOverride?: string;
		},
	): Promise<AgentInfo> {
		const normalizedResumeSessionId =
			typeof opts?.resumeSessionId === "string" && opts.resumeSessionId.trim()
				? opts.resumeSessionId.trim()
				: undefined;
		const normalizedKickoffMessage =
			typeof opts?.kickoffMessage === "string" && opts.kickoffMessage.trim() ? opts.kickoffMessage.trim() : "";
		const spawnedAt = Date.now();
		let tasksAgentId: string | null = null;
		let rpc: OmsRpcClient | null = null;
		const agentType = (spawnConfig.agentType ?? configKey) as AgentType;
		const tasksActorName = spawnConfig.tasksActorName ?? `oms-${configKey}`;

		try {
			// Claim handling (only when taskId is non-null)
			if (taskId != null) {
				if (opts?.claim === true) {
					await this.tasksClient.claim(taskId);
				} else if (opts?.claim === false) {
					// claim:false means caller already owns this task (resume path).
					// Re-check status to guard against races where the task was
					// blocked/closed between scheduler snapshot and worker spawn.
					const current = await this.tasksClient.show(taskId);
					const status = (typeof current.status === "string" ? current.status : "").toLowerCase();
					if (status === "blocked" || status === "closed" || status === "deferred") {
						throw new Error(`Task ${taskId} status is '${status}'; refusing to spawn ${configKey}`);
					}
				}
			}
			// claim:undefined means no claim behavior (finisher/issuer paths).
			const agentName = opts?.agentNamePrefix ?? (taskId ? `${configKey}-${taskId}` : `${configKey}-${spawnedAt}`);
			tasksAgentId = await this.tasksClient.createAgent(agentName);
			await this.tasksClient.setAgentState(tasksAgentId, "spawning");
			const agentId = opts?.agentIdBuilder
				? opts.agentIdBuilder(tasksAgentId)
				: taskId
					? `${agentType}:${taskId}:${tasksAgentId}`
					: `${agentType}:${tasksAgentId}`;
			const agentCfg = (this.config.agents as Record<string, { model?: string; thinking: string; tools?: string }>)[
				agentType
			];
			const model = opts?.modelOverride ?? agentCfg?.model;
			const thinking = opts?.thinkingOverride ?? agentCfg?.thinking ?? "medium";
			const toolsBase = normalizeTools(agentCfg?.tools ?? spawnConfig.defaultTools, spawnConfig.defaultTools, {
				stripBash: spawnConfig.stripBash,
			});
			// Build extension args from config
			const extensionArgs: string[] = [];
			for (const key of spawnConfig.extensionKeys) {
				extensionArgs.push("--extension", this.resolveExtensionPath(key));
			}

			const promptFile = spawnConfig.promptFile ?? `${configKey}.md`;
			const promptPath = path.resolve(this.promptsDir, promptFile);
			const args: string[] = [
				"--thinking",
				thinking,
				...(model ? ["--model", model] : []),
				"--no-pty",
				...(normalizedResumeSessionId ? ["--resume", normalizedResumeSessionId] : []),
				...extensionArgs,
				"--tools",
				toolsBase,
				"--append-system-prompt",
				promptPath,
			];
			// Handle replicas
			let replicaDir: string | undefined;
			let agentCwd = this.tasksClient.workingDir;
			if (spawnConfig.replica === "create" && this.config.enableReplicas && this.#replicaManager && taskId) {
				try {
					replicaDir = await this.#replicaManager.createReplica(taskId);
					agentCwd = replicaDir;
				} catch (err) {
					logger.warn(
						`agents/spawner.ts: failed to create ${configKey} replica directory, falling back to root cwd`,
						{ taskId, err },
					);
				}
			} else if (spawnConfig.replica === "resolve" && taskId) {
				replicaDir = await this.#resolveFinisherReplicaDir(taskId);
				if (replicaDir) agentCwd = replicaDir;
			}

			const envBase: Record<string, string | undefined> = {
				TASKS_ACTOR: tasksActorName,
				OMS_AGENT_TYPE: agentType,
				...(taskId != null ? { OMS_TASK_ID: taskId } : {}),
				OMS_AGENT_ID: agentId,
				OMS_SINGULARITY_SOCK: this.ipcSockPath,
				...opts?.extraEnv,
			};
			rpc = new OmsRpcClient({
				ompCli: this.config.ompCli,
				cwd: agentCwd,
				env: buildEnv(envBase),
				args,
			});

			rpc.start();

			// Build and send prompt
			let promptText: string | null = null;
			if (normalizedResumeSessionId) {
				if (normalizedKickoffMessage) {
					promptText = normalizedKickoffMessage;
					await rpc.prompt(promptText);
				}
			} else if (opts?.rawPrompt) {
				promptText = opts.rawPrompt;
				await rpc.prompt(promptText);
			} else if (taskId != null) {
				const task = await this.tasksClient.show(taskId);
				let extra: string;
				if (opts?.buildPromptExtra) {
					extra = await opts.buildPromptExtra(task as unknown as Record<string, unknown>);
				} else if (opts?.promptExtra) {
					extra = opts.promptExtra;
				} else {
					extra = normalizedKickoffMessage ? `## Implementation Guidance\n\n${normalizedKickoffMessage}` : "";
				}
				promptText = buildTaskPrompt({
					agentType,
					task: {
						id: task.id,
						title: task.title,
						description: task.description,
						acceptance: task.acceptance_criteria,
						issueType: task.issue_type,
						labels: task.labels,
					},
					extra: extra || undefined,
				});
				await rpc.prompt(promptText);
			}

			// Set slot (unless config says skip or taskId is null)
			if (spawnConfig.setSlot !== false && taskId != null) {
				await this.tasksClient.setSlot(tasksAgentId, "callbackHandler", taskId);
			}
			await this.tasksClient.setAgentState(tasksAgentId, "working");

			const info: AgentInfo = {
				id: agentId,
				agentType,
				taskId,
				replicaDir: opts?.replicaDirOverride ?? replicaDir,
				tasksAgentId,
				status: "working",
				usage: createEmptyAgentUsage(),
				events: [],
				spawnedAt,
				lastActivity: Date.now(),
				rpc,
				model,
				thinking,
				sessionId: this.getAgentSessionId(rpc) ?? normalizedResumeSessionId,
			};
			this.registry.register(info);
			if (promptText?.trim()) {
				this.registry.pushEvent(info.id, { type: "initial_prompt", text: promptText, ts: Date.now() });
			}
			return info;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (tasksAgentId) {
				if (taskId != null) {
					try {
						const action = normalizedResumeSessionId ? "resume" : "spawn";
						await this.tasksClient.comment(
							taskId,
							`Failed to ${action} ${configKey} RPC agent for task ${taskId}.\n` +
								`tasksAgentId: ${tasksAgentId}\n` +
								`sessionId: ${normalizedResumeSessionId ?? "(none)"}\n` +
								`error: ${message}`,
						);
					} catch (err) {
						logger.debug("agents/spawner.ts: failed to record spawn-failure comment (non-fatal)", { err });
					}
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
		const trimmedOutput = workerOutput?.trim() || "(none)";
		return await this.spawnAgent("finisher", taskId, {
			promptExtra: `Implementation output:\n\n${trimmedOutput}`,
		});
	}
	async spawnIssuer(taskId: string, kickoffMessage?: string): Promise<AgentInfo> {
		const tasksClient = this.tasksClient;
		return await this.spawnAgent("issuer", taskId, {
			kickoffMessage,
			buildPromptExtra: async task => {
				const dependsOnIds = Array.isArray(task.depends_on_ids)
					? (task.depends_on_ids as unknown[])
							.filter(
								(dependencyId): dependencyId is string =>
									typeof dependencyId === "string" && dependencyId.trim().length > 0,
							)
							.map(dependencyId => dependencyId.trim())
					: [];
				const parentComments = dependsOnIds.length ? await formatParentTaskComments(tasksClient, dependsOnIds) : "";
				const referenceIds = Array.isArray(task.references)
					? (task.references as unknown[])
							.filter(
								(referenceId): referenceId is string =>
									typeof referenceId === "string" && referenceId.trim().length > 0,
							)
							.map(referenceId => referenceId.trim())
					: [];
				const referencedTaskComments = referenceIds.length
					? await formatReferencedTaskComments(tasksClient, referenceIds)
					: "";
				const kickoffContext = kickoffMessage?.trim() ? `## Kickoff Context\n\n${kickoffMessage.trim()}` : "";
				return [parentComments, referencedTaskComments, kickoffContext].filter(Boolean).join("\n\n");
			},
		});
	}
	async resumeAgent(taskId: string, sessionId: string, kickoffMessage?: string): Promise<AgentInfo> {
		return await this.spawnAgent("issuer", taskId, { resumeSessionId: sessionId, kickoffMessage });
	}
	async spawnMerger(taskId: string, replicaDir: string): Promise<AgentInfo> {
		const normalizedTaskId = taskId.trim();
		if (!normalizedTaskId) throw new Error("spawnMerger requires a non-empty taskId");
		const normalizedReplicaDir = replicaDir.trim();
		if (!normalizedReplicaDir) throw new Error("spawnMerger requires a non-empty replicaDir");
		return await this.spawnAgent("merger", normalizedTaskId, {
			promptExtra: `Replica directory: ${normalizedReplicaDir}\nProject root: ${this.tasksClient.workingDir}`,
			extraEnv: { OMS_REPLICA_DIR: normalizedReplicaDir },
			replicaDirOverride: normalizedReplicaDir,
		});
	}
	async spawnSteering(taskId: string, recentMessages: string): Promise<AgentInfo> {
		return await this.spawnAgent("steering", taskId, {
			promptExtra: `Recent messages (for steering context):\n\n${recentMessages?.trim() ? recentMessages.trim() : "(none)"}`,
		});
	}
}
