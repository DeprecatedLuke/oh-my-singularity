import {
	DEFAULT_LAYOUT_AGENTS_WIDTH_RATIO,
	DEFAULT_LAYOUT_SYSTEM_HEIGHT_RATIO,
	DEFAULT_LAYOUT_TASKS_HEIGHT_RATIO,
	DEFAULT_MAX_WORKERS,
	LIMIT_AGENT_EVENT_BUFFER,
	TIMEOUT_DEFAULT_POLL_MS,
	TIMEOUT_STEERING_INTERVAL_MS,
} from "./config/constants";
import type { AgentRole } from "./core/types";

export type { AgentRole } from "./core/types";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type RoleKey = AgentRole | "orchestrator";

export interface RoleConfig {
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

	layout: {
		/** Height ratio (0..1) for the Tasks pane (top). */
		tasksHeightRatio: number;
		/** Width ratio (0..1) for the Agents pane (right). */
		agentsWidthRatio: number;
		/** Height ratio (0..1) of the singularity area for the OMS/system pane (bottom). */
		systemHeightRatio: number;
	};

	roles: Record<Exclude<AgentRole, "singularity">, RoleConfig>;
}

// Default tool allowlists per role (can be overridden via config `roles.<role>.tools` or OMS_TOOLS_<ROLE>).

export const WORKER_TOOLS =
	"bash,read,edit,write,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

export const FINISHER_TOOLS = "bash,read,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

export const STEERING_TOOLS = "bash,read,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

export const ISSUER_TOOLS = "bash,read,grep,find,lsp,python,notebook,browser,fetch,web_search,todo_write,task";

export const DEFAULT_CONFIG: OmsConfig = {
	ompCli: "omp",
	pollIntervalMs: TIMEOUT_DEFAULT_POLL_MS,
	steeringIntervalMs: TIMEOUT_STEERING_INTERVAL_MS,
	maxWorkers: DEFAULT_MAX_WORKERS,
	agentEventLimit: LIMIT_AGENT_EVENT_BUFFER,

	layout: {
		tasksHeightRatio: DEFAULT_LAYOUT_TASKS_HEIGHT_RATIO,
		agentsWidthRatio: DEFAULT_LAYOUT_AGENTS_WIDTH_RATIO,
		systemHeightRatio: DEFAULT_LAYOUT_SYSTEM_HEIGHT_RATIO,
	},

	roles: {
		issuer: {
			model: "sonnet",
			thinking: "medium",
			tools: ISSUER_TOOLS,
		},
		worker: {
			model: "sonnet",
			thinking: "xhigh",
			tools: WORKER_TOOLS,
		},
		"designer-worker": {
			model: "opus",
			thinking: "xhigh",
			tools: WORKER_TOOLS,
		},
		finisher: {
			model: "sonnet",
			thinking: "medium",
			tools: FINISHER_TOOLS,
		},
		steering: {
			model: "sonnet",
			thinking: "medium",
		},
	},
};

export type OmsConfigOverride = Partial<Omit<OmsConfig, "layout" | "roles">> & {
	layout?: Partial<OmsConfig["layout"]>;
	roles?: Partial<Record<RoleKey, Partial<RoleConfig>>>;
};

function normalizeRoleKey(role: string): Exclude<AgentRole, "singularity"> | null {
	if (role === "orchestrator") return "finisher";
	if (
		role === "issuer" ||
		role === "worker" ||
		role === "designer-worker" ||
		role === "finisher" ||
		role === "steering"
	) {
		return role;
	}

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

const ROLE_ENV_SUFFIX: Record<Exclude<AgentRole, "singularity">, string> = {
	issuer: "ISSUER",
	worker: "WORKER",
	"designer-worker": "DESIGNER_WORKER",
	finisher: "FINISHER",
	steering: "STEERING",
};

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

	const roleOverrides: Partial<Record<RoleKey, Partial<RoleConfig>>> = {};
	for (const role of ["issuer", "worker", "designer-worker", "finisher", "steering"] as const) {
		const suffix = ROLE_ENV_SUFFIX[role];
		const model = readNonEmptyEnv(`OMS_MODEL_${suffix}`);
		const thinking = readNonEmptyEnv(`OMS_THINKING_${suffix}`);
		const tools = readNonEmptyEnv(`OMS_TOOLS_${suffix}`);

		const roleOverride: Partial<RoleConfig> = {};
		if (model) roleOverride.model = model;
		if (thinking && isThinkingLevel(thinking)) roleOverride.thinking = thinking;
		if (tools) roleOverride.tools = tools;

		if (Object.keys(roleOverride).length > 0) {
			roleOverrides[role] = roleOverride;
		}
	}

	if (Object.keys(roleOverrides).length > 0) {
		override.roles = roleOverrides;
	}

	return override;
}

export function mergeOmsConfig(base: OmsConfig, override: OmsConfigOverride): OmsConfig {
	const mergedRoles: Record<Exclude<AgentRole, "singularity">, RoleConfig> = { ...base.roles };

	const mergedLayout = {
		...base.layout,
		...(override.layout ?? {}),
	};

	if (override.roles) {
		for (const [role, roleOverride] of Object.entries(override.roles)) {
			if (!roleOverride) continue;
			const normalized = normalizeRoleKey(role);
			if (!normalized) continue;

			const filteredOverride: Partial<RoleConfig> = {};
			if (roleOverride.model !== undefined) filteredOverride.model = roleOverride.model;
			if (roleOverride.thinking !== undefined) filteredOverride.thinking = roleOverride.thinking;
			if (roleOverride.tools !== undefined) filteredOverride.tools = roleOverride.tools;
			mergedRoles[normalized] = {
				...mergedRoles[normalized],
				...filteredOverride,
			} as RoleConfig;
		}
	}

	return {
		...base,
		...override,
		layout: mergedLayout,
		roles: mergedRoles,
	};
}
