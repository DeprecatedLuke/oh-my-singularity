// Time unit constants
export const MS_PER_SECOND = 1_000;
export const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;

export const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

const MILLISECONDS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MILLISECONDS_PER_HOUR = MILLISECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const MILLISECONDS_PER_DAY = MILLISECONDS_PER_HOUR * HOURS_PER_DAY;

export const TIMEOUT_MIN_MS = MS_PER_SECOND;
export const TIMEOUT_DEFAULT_POLL_MS = 5_000;
export const TIMEOUT_STEERING_INTERVAL_MS = 15 * MILLISECONDS_PER_MINUTE;
export const TIMEOUT_STALE_AGENT_TTL_MS = 15 * MILLISECONDS_PER_MINUTE;
export const TIMEOUT_AGENT_WAIT_MS = MILLISECONDS_PER_DAY;
export const TIMEOUT_QUIET_WINDOW_BASE_MS = 1_500;
export const TIMEOUT_QUIET_WINDOW_POLL_OFFSET_MS = TIMEOUT_MIN_MS;
export const TIMEOUT_REGISTRY_DEFAULT_INTERVAL_MS = 15_000;

export const TIMEOUT_AGENT_STOP_GRACE_MS = 2_000;

export const DEFAULT_MAX_WORKERS = 5;
export const DEFAULT_LAYOUT_TASKS_HEIGHT_RATIO = 0.25;
export const DEFAULT_LAYOUT_AGENTS_WIDTH_RATIO = 0.45;
export const DEFAULT_LAYOUT_SYSTEM_HEIGHT_RATIO = 0.3;

export const INTERVAL_WAIT_SLEEP_MS = 200;
export const INTERVAL_POLLER_MIN_MS = 100;

export const DELAY_DEFERRED_FLUSH_MS = 250;
export const DELAY_PIPE_EMPTY_WORK_GRACE_MS = 750;
export const DELAY_PIPE_FORCE_EXIT_GRACE_MS = 3_000;

export const LIMIT_ACTIVITY_DEFAULT = 100;
export const LIMIT_TASK_LIST_DEFAULT = 50;
export const LIMIT_ACTIVITY_MAX_EVENTS = 5_000;
export const LIMIT_AGENT_LOG_MESSAGES = 2_000;
export const LIMIT_AGENT_ISSUES = 400;
export const LIMIT_AGENT_LOGS = 400;
export const LIMIT_AGENT_EVENT_BUFFER = 10_000;
export const LIMIT_MESSAGE_HISTORY_DEFAULT = 40;
export const LIMIT_MESSAGE_HISTORY_MAX = 200;
export const LIMIT_POLLER_SEEN_ACTIVITY = 2_000;
export const LIMIT_POLLER_ACTIVITY_DEFAULT = 200;
export const LIMIT_TASK_TREE_RENDER_DEPTH = 10_000;
export const LIMIT_AGENT_MAX_RETRIES = 3;

export const UI_FLASH_DURATION_MS = 100;
export const UI_FLASH_DEBOUNCE_MS = 80;
export const UI_SCROLL_STEP_LINES = 3;
export const UI_RESULT_MAX_LINES = 8;
export const UI_MARKDOWN_CACHE_LIMIT = 128;
export const UI_AGENT_SUMMARY_MAX_CHARS = 180;

export const PATH_MAX_SOCK_PATH_LENGTH = 100;

export const AGENT_EXTENSION_FILENAMES = {
	worker: "tasks-worker.ts",
	speedy: "tasks-speedy.ts",
	designer: "tasks-designer.ts",
	finisher: "tasks-finisher.ts",
	merger: "tasks-merger.ts",
	steering: "tasks-steering.ts",
	issuer: "tasks-issuer.ts",
	waitForAgent: "wait-for-agent.ts",
	readMessageHistory: "read-message-history.ts",
	readTaskMessageHistory: "read-task-message-history.ts",
	steerAgent: "steer-agent.ts",
	steeringReplaceAgent: "steering-replace-agent.ts",
	tasksBashGuard: "tasks-bash-guard.ts",
	ompCrashLogger: "omp-crash-logger.ts",
	startTasks: "start-tasks.ts",
	tasksCommand: "tasks-command.ts",
	tasksSingularity: "tasks-singularity.ts",
	singularityToolGuard: "singularity-tool-guard.ts",
	interruptAgent: "interrupt-agent.ts",
	replaceAgent: "replace-agent.ts",
	deleteTaskIssue: "delete-task-issue.ts",
} as const;

export const SINGULARITY_EXTENSION_FILENAMES = [
	AGENT_EXTENSION_FILENAMES.startTasks,
	AGENT_EXTENSION_FILENAMES.tasksCommand,
	AGENT_EXTENSION_FILENAMES.tasksSingularity,
	AGENT_EXTENSION_FILENAMES.replaceAgent,
	AGENT_EXTENSION_FILENAMES.deleteTaskIssue,
	AGENT_EXTENSION_FILENAMES.singularityToolGuard,
	AGENT_EXTENSION_FILENAMES.tasksBashGuard,
] as const;

// --- Default tool allowlists (module-private, consumed via AGENT_CONFIGS entries) ---

const WORKER_TOOLS = "bash,read,edit,write,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

const FINISHER_TOOLS = "bash,read,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

const MERGER_TOOLS = "bash,read,grep,find";

const STEERING_TOOLS = "bash,read,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

const ISSUER_TOOLS = "bash,read,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

// --- Thinking levels ---

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// --- Unified agent config (spawn + lifecycle + display + runtime defaults) ---

export type LifecycleAction = "close" | "block" | "advance";

/** Lifecycle validation fields — present only on agents that participate in advance_lifecycle. */
export interface AgentLifecycleConfig {
	/** Actions this agent is allowed to call. */
	allowedActions: ReadonlySet<LifecycleAction>;
	/** Agent types this agent can advance to (only relevant when action="advance"). */
	allowedAdvanceTargets: readonly string[];
	/** Human-readable description of this agent for issuer prompt context. */
	description?: string;
}

export type SpawnGuardAgent = "worker" | "issuer" | "finisher";

/** Unified per-agent configuration: spawn behavior, lifecycle, display, and runtime defaults. */
export interface AgentBehaviorConfig {
	// --- Spawn config ---
	/** Extension filename keys from AGENT_EXTENSION_FILENAMES (loaded in order). */
	extensionKeys: readonly string[];
	/** Default tools if agent model config doesn't specify tools. */
	defaultTools: string;
	/** Whether to strip bash from the tool list. */
	stripBash: boolean;
	/** Replica strategy: "create" for implementation agents, "resolve" for finisher, "none" for others. */
	replica: "create" | "resolve" | "none";
	/** Spawn guard agent for deduplication. null = no guard. */
	spawnGuard: SpawnGuardAgent | null;
	/** Override prompt filename. Default: `${configKey}.md` */
	promptFile?: string;
	/** Whether to call setSlot after spawn. Default: true */
	setSlot?: boolean;
	/** Override the AgentType in AgentInfo and OMS_AGENT_TYPE env. Default: configKey */
	agentType?: string;
	/** Override TASKS_ACTOR env var. Default: `oms-${configKey}` */
	tasksActorName?: string;

	// --- Lifecycle config (optional — not all agents participate in advance_lifecycle) ---
	/** Actions this agent is allowed to call. */
	allowedActions?: ReadonlySet<LifecycleAction>;
	/** Agent types this agent can advance to (only relevant when action="advance"). */
	allowedAdvanceTargets?: readonly string[];
	/** Human-readable description of this agent for issuer prompt context. */
	description?: string;
	/** Whether this agent can be a target for replace_agent. */
	replaceable?: boolean;

	// --- Display config ---
	/** ANSI truecolor foreground escape string for TUI rendering. */
	fg?: string;

	// --- Runtime defaults (spawnable agents only) ---
	/** Default model name passed to `omp --model`. */
	model?: string;
	/** Default thinking level. */
	thinking?: ThinkingLevel;
	/** Env-var suffix for OMS_MODEL / OMS_THINKING / OMS_TOOLS overrides. */
	envSuffix?: string;
}
const ALL_LIFECYCLE_ACTIONS: ReadonlySet<LifecycleAction> = new Set(["close", "block", "advance"]);
const BLOCK_AND_ADVANCE: ReadonlySet<LifecycleAction> = new Set(["block", "advance"]);
/**
 * Single source of truth for all agent configurations.
 * Adding a new agent = one entry here + a prompt file.
 */
export const AGENT_CONFIGS = {
	singularity: {
		extensionKeys: [],
		defaultTools: "",
		stripBash: false,
		replica: "none",
		spawnGuard: null,
		agentType: "singularity",
		fg: "\x1b[38;2;0;206;209m", // #00CED1  dark cyan
	},
	worker: {
		extensionKeys: ["ompCrashLogger", "worker", "tasksBashGuard", "waitForAgent"],
		defaultTools: WORKER_TOOLS,
		stripBash: false,
		replica: "create",
		spawnGuard: "worker",
		allowedActions: BLOCK_AND_ADVANCE,
		allowedAdvanceTargets: ["finisher"],
		description: "General-purpose implementation agent",
		replaceable: true,
		fg: "\x1b[38;2;100;149;237m", // #6495ED  cornflower blue
		model: "opus",
		thinking: "xhigh",
		envSuffix: "WORKER",
	},
	designer: {
		extensionKeys: ["ompCrashLogger", "designer", "tasksBashGuard", "waitForAgent"],
		defaultTools: WORKER_TOOLS,
		stripBash: false,
		replica: "create",
		spawnGuard: "worker",
		allowedActions: BLOCK_AND_ADVANCE,
		allowedAdvanceTargets: ["finisher"],
		description: "UI/UX-focused implementation agent for design-heavy tasks",
		replaceable: true,
		fg: "\x1b[38;2;218;112;214m", // #DA70D6  orchid
		model: "opus",
		thinking: "high",
		envSuffix: "DESIGNER_WORKER",
	},
	speedy: {
		extensionKeys: ["ompCrashLogger", "speedy", "tasksBashGuard"],
		defaultTools: WORKER_TOOLS,
		stripBash: false,
		replica: "create",
		spawnGuard: "worker",
		allowedActions: ALL_LIFECYCLE_ACTIONS,
		allowedAdvanceTargets: ["issuer", "finisher"],
		description: "Fast-worker for tiny-scope tasks; can close directly or escalate",
		replaceable: true,
		fg: "\x1b[38;2;255;160;122m", // #FFA07A  light salmon
		model: "sonnet-4-6",
		thinking: "high",
		envSuffix: "SPEEDY",
	},
	finisher: {
		extensionKeys: ["ompCrashLogger", "finisher", "tasksBashGuard"],
		defaultTools: FINISHER_TOOLS,
		stripBash: false,
		replica: "resolve",
		spawnGuard: "finisher",
		allowedActions: ALL_LIFECYCLE_ACTIONS,
		allowedAdvanceTargets: ["worker", "issuer"],
		description: "Lifecycle finalizer; verifies work and closes tasks",
		replaceable: true,
		fg: "\x1b[38;2;255;99;71m", // #FF6347  tomato
		model: "sonnet-4-6",
		thinking: "low",
		envSuffix: "FINISHER",
	},
	issuer: {
		extensionKeys: ["ompCrashLogger", "issuer", "tasksBashGuard"],
		defaultTools: ISSUER_TOOLS,
		stripBash: false,
		replica: "none",
		spawnGuard: "issuer",
		allowedActions: ALL_LIFECYCLE_ACTIONS,
		allowedAdvanceTargets: ["worker", "designer"],
		description: "Codebase scout; assesses tasks and selects implementation agent",
		replaceable: true,
		fg: "\x1b[38;2;124;252;0m", // #7CFC00  lawn green
		model: "sonnet-4-6",
		thinking: "minimal",
		envSuffix: "ISSUER",
	},
	merger: {
		extensionKeys: ["ompCrashLogger", "merger", "tasksBashGuard"],
		defaultTools: MERGER_TOOLS,
		stripBash: false,
		replica: "none",
		spawnGuard: null,
		fg: "\x1b[38;2;147;112;219m", // #9370DB  medium purple
		model: "sonnet-4-6",
		thinking: "medium",
		envSuffix: "MERGER",
	},
	steering: {
		extensionKeys: ["ompCrashLogger", "steering", "readTaskMessageHistory", "steeringReplaceAgent", "tasksBashGuard"],
		defaultTools: STEERING_TOOLS,
		stripBash: false,
		replica: "none",
		spawnGuard: null,
		fg: "\x1b[38;2;255;215;0m", // #FFD700  gold
		model: "sonnet-4-6",
		thinking: "low",
		envSuffix: "STEERING",
	},
} satisfies Readonly<Record<string, AgentBehaviorConfig>>;

/** All config keys in AGENT_CONFIGS. */
export type AgentConfigKey = keyof typeof AGENT_CONFIGS;

/**
 * Config entries that override agentType are spawn variants or non-spawnable, not distinct agents.
 * Config entries that override agentType are spawn variants, not distinct agents.
 */
type VariantConfigKey = {
	[K in AgentConfigKey]: (typeof AGENT_CONFIGS)[K] extends { agentType: string } ? K : never;
}[AgentConfigKey];

/** Agents that can be spawned from AGENT_CONFIGS (excludes variant config keys). */
export type SpawnableAgent = Exclude<AgentConfigKey, VariantConfigKey>;

/** All runtime agent identifiers. "singularity" is the main OMS process, not spawned from config. */
export type AgentType = "singularity" | SpawnableAgent;

/** String-indexed alias for runtime lookups in helper functions. */
const AGENT_CONFIGS_LOOKUP: Readonly<Record<string, AgentBehaviorConfig>> = AGENT_CONFIGS;

/** Runtime set of spawnable agent names — derived from AGENT_CONFIGS (excludes variant config keys). */
export const SPAWNABLE_AGENTS: ReadonlySet<SpawnableAgent> = new Set(
	(Object.keys(AGENT_CONFIGS) as AgentConfigKey[]).filter(
		(key): key is SpawnableAgent => !AGENT_CONFIGS_LOOKUP[key]?.agentType,
	),
);

/** Extract lifecycle config for an agent, or undefined if the agent has no lifecycle restrictions. */
export function getAgentLifecycleConfig(agentType: string): AgentLifecycleConfig | undefined {
	const cfg = AGENT_CONFIGS_LOOKUP[agentType];
	if (!cfg?.allowedActions) return undefined;
	return {
		allowedActions: cfg.allowedActions,
		allowedAdvanceTargets: cfg.allowedAdvanceTargets ?? [],
		description: cfg.description,
	};
}

/** Extract spawn config for an agent, or undefined if the agent is not registered. */
export function getAgentSpawnConfig(agentType: string): AgentBehaviorConfig | undefined {
	return AGENT_CONFIGS_LOOKUP[agentType];
}
export function getValidAdvanceTargets(): string[] {
	const targets = new Set<string>();
	for (const cfg of Object.values(AGENT_CONFIGS_LOOKUP)) {
		if (cfg.allowedAdvanceTargets) {
			for (const t of cfg.allowedAdvanceTargets) targets.add(t);
		}
	}
	return [...targets];
}

/** Agents that can be targeted by replace_agent — derived from AGENT_CONFIGS. */
export function getReplaceableAgents(): ReadonlySet<string> {
	const agents = new Set<string>();
	for (const [name, cfg] of Object.entries(AGENT_CONFIGS_LOOKUP)) {
		if (cfg.replaceable === true) agents.add(name);
	}
	return agents;
}

// Smoke-test marker: lifecycle pipeline validated
