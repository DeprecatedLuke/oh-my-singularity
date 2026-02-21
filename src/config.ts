// lifecycle-interrupt-advance-test
// OMS configuration
// Defines OMS configuration types, defaults, and environment-variable loading/merge behavior for agents and runtime settings.
import type { SpawnableAgent, ThinkingLevel } from "./config/constants";
import {
	DEFAULT_LAYOUT_AGENTS_WIDTH_RATIO,
	DEFAULT_LAYOUT_SYSTEM_HEIGHT_RATIO,
	DEFAULT_LAYOUT_TASKS_HEIGHT_RATIO,
	DEFAULT_MAX_WORKERS,
	getAgentSpawnConfig,
	LIMIT_AGENT_EVENT_BUFFER,
	SPAWNABLE_AGENTS,
	TIMEOUT_DEFAULT_POLL_MS,
	TIMEOUT_STEERING_INTERVAL_MS,
} from "./config/constants";

export type { AgentType, SpawnableAgent, ThinkingLevel } from "./config/constants";

import { logger } from "./utils";

type AgentKey = SpawnableAgent | "orchestrator";

export interface AgentModelConfig {
	/** Fuzzy model name or provider/id string passed to `omp --model`. */
	model: string;
	thinking: ThinkingLevel;
	/** Optional explicit tools allowlist passed to `omp --tools`. */
	tools?: string;
}

export interface OmsConfig {
	ompCli: string;
	pollIntervalMs: number;
	steeringIntervalMs: number;
	maxWorkers: number;
	/** Rolling per-agent event buffer size for TUI logs. */
	agentEventLimit: number;
	enableReplicas: boolean;

	layout: {
		/** Height ratio (0..1) for the Tasks pane (top). */
		tasksHeightRatio: number;
		/** Width ratio (0..1) for the Agents pane (right). */
		agentsWidthRatio: number;
		/** Height ratio (0..1) of the singularity area for the OMS/system pane (bottom). */
		systemHeightRatio: number;
	};

	agents: Record<SpawnableAgent, AgentModelConfig>;
}

function buildDefaultAgents(): Record<SpawnableAgent, AgentModelConfig> {
	const agents = {} as Record<SpawnableAgent, AgentModelConfig>;
	for (const agentType of SPAWNABLE_AGENTS) {
		const cfg = getAgentSpawnConfig(agentType);
		if (!cfg) continue;
		agents[agentType] = {
			model: cfg.model ?? "sonnet",
			thinking: cfg.thinking ?? "low",
			tools: cfg.defaultTools,
		};
	}
	return agents;
}

export const DEFAULT_CONFIG: OmsConfig = {
	ompCli: "omp",
	pollIntervalMs: TIMEOUT_DEFAULT_POLL_MS,
	steeringIntervalMs: TIMEOUT_STEERING_INTERVAL_MS,
	maxWorkers: DEFAULT_MAX_WORKERS,
	agentEventLimit: LIMIT_AGENT_EVENT_BUFFER,
	enableReplicas: false,

	layout: {
		tasksHeightRatio: DEFAULT_LAYOUT_TASKS_HEIGHT_RATIO,
		agentsWidthRatio: DEFAULT_LAYOUT_AGENTS_WIDTH_RATIO,
		systemHeightRatio: DEFAULT_LAYOUT_SYSTEM_HEIGHT_RATIO,
	},

	agents: buildDefaultAgents(),
};

export type OmsConfigOverride = Partial<Omit<OmsConfig, "layout" | "agents">> & {
	layout?: Partial<OmsConfig["layout"]>;
	agents?: Partial<Record<AgentKey, Partial<AgentModelConfig>>>;
};

function normalizeAgentKey(agentType: string): SpawnableAgent | null {
	if (agentType === "orchestrator") return "finisher";
	if ((SPAWNABLE_AGENTS as ReadonlySet<string>).has(agentType)) return agentType as SpawnableAgent;
	return null;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function readNonEmptyEnv(name: string): string | undefined {
	const value = process.env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
	const raw = readNonEmptyEnv(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
}

function readBooleanEnv(name: string): boolean | undefined {
	const raw = readNonEmptyEnv(name);
	if (!raw) return undefined;
	const normalized = raw.toLowerCase();
	if (normalized === "1" || normalized === "true") return true;
	if (normalized === "0" || normalized === "false") return false;
	return undefined;
}

export function loadConfigFromEnvironment(): OmsConfigOverride {
	const override: OmsConfigOverride = {};

	const ompCli = readNonEmptyEnv("OMS_OMP_CLI");
	if (ompCli) override.ompCli = ompCli;

	const pollIntervalMs = readPositiveIntEnv("OMS_POLL_INTERVAL_MS");
	if (typeof pollIntervalMs === "number") override.pollIntervalMs = pollIntervalMs;

	const steeringIntervalMs = readPositiveIntEnv("OMS_STEERING_INTERVAL_MS");
	if (typeof steeringIntervalMs === "number") override.steeringIntervalMs = steeringIntervalMs;

	const maxWorkers = readPositiveIntEnv("OMS_MAX_WORKERS");
	if (typeof maxWorkers === "number") override.maxWorkers = maxWorkers;

	const agentEventLimit = readPositiveIntEnv("OMS_AGENT_EVENT_LIMIT");
	if (typeof agentEventLimit === "number") override.agentEventLimit = agentEventLimit;

	const enableReplicas = readBooleanEnv("OMS_ENABLE_REPLICAS");
	if (typeof enableReplicas === "boolean") {
		if (enableReplicas && process.platform !== "linux") {
			logger.warn("OMS_ENABLE_REPLICAS=true ignored: OverlayFS replicas are only supported on Linux");
			override.enableReplicas = false;
		} else {
			override.enableReplicas = enableReplicas;
		}
	}

	const agentOverrides: Partial<Record<AgentKey, Partial<AgentModelConfig>>> = {};
	for (const agentType of SPAWNABLE_AGENTS) {
		const suffix = getAgentSpawnConfig(agentType)?.envSuffix;
		if (!suffix) continue;
		const model = readNonEmptyEnv(`OMS_MODEL_${suffix}`);
		const thinking = readNonEmptyEnv(`OMS_THINKING_${suffix}`);
		const tools = readNonEmptyEnv(`OMS_TOOLS_${suffix}`);

		const agentOverride: Partial<AgentModelConfig> = {};
		if (model) agentOverride.model = model;
		if (thinking && isThinkingLevel(thinking)) agentOverride.thinking = thinking;
		if (tools) agentOverride.tools = tools;

		if (Object.keys(agentOverride).length > 0) {
			agentOverrides[agentType] = agentOverride;
		}
	}

	if (Object.keys(agentOverrides).length > 0) {
		override.agents = agentOverrides;
	}

	return override;
}

export function mergeOmsConfig(base: OmsConfig, override: OmsConfigOverride): OmsConfig {
	const mergedAgents: Record<SpawnableAgent, AgentModelConfig> = { ...base.agents };

	const mergedLayout = {
		...base.layout,
		...(override.layout ?? {}),
	};

	if (override.agents) {
		for (const [agentType, agentOverride] of Object.entries(override.agents)) {
			if (!agentOverride) continue;
			const normalized = normalizeAgentKey(agentType);
			if (!normalized) continue;

			mergedAgents[normalized] = {
				...mergedAgents[normalized],
				...agentOverride,
			};
		}
	}

	return {
		...base,
		...override,
		layout: mergedLayout,
		agents: mergedAgents,
	};
}
