/**
 * Workflow configuration types for OMS orchestration.
 * Defines the schema for role-based workflow profiles with permissions, extensions, and steering.
 */

import type { RenderingStyle, RoleCategory, RoleId } from "../core/types";

/**
 * Steering configuration for supervisor roles.
 * Controls how steering/supervision behaves for a workflow.
 */
export interface SteeringConfig {
	/** Enable steering for this workflow */
	enabled: boolean;
	/** Interval in milliseconds between steering checks */
	intervalMs: number;
	/** Role ID that performs steering (must be a "supervisor" category role) */
	roleId: string;
}

/**
 * Extension configuration entry.
 * Maps logical extension names to file paths.
 */
export interface ExtensionConfig {
	/** Path to extension file (relative to project root, absolute, or built-in name) */
	path: string;
}

/**
 * Extended role configuration with behavioral and resource settings.
 * Allows customization of built-in roles or definition of new custom roles.
 */
export interface ExtendedRoleConfig {
	/** Semantic category (overrides default for custom roles) */
	category?: RoleCategory;

	/** How lifecycle events are rendered in TUI */
	rendering?: RenderingStyle;

	/** Can this role modify files via edit/write tools */
	canModifyFiles?: boolean;

	/** Can this role close or update tasks */
	canCloseTask?: boolean;

	/** Can this role call advance_lifecycle tool */
	canAdvanceLifecycle?: boolean;

	/** Which roles this role can spawn (empty array = cannot spawn) */
	canSpawn?: RoleId[];

	/** Path to custom prompt (absolute or relative to config) */
	prompt?: string;

	/** Extension names or paths this role can use */
	extensions?: string[];

	/** Color for TUI rendering (any CSS color name or hex value) */
	color?: string;
}

/**
 * Main workflow configuration.
 * Defines roles, extensions, and behavior for a workflow profile.
 */
export interface WorkflowConfig {
	/** Schema version (for forward compatibility) */
	version: "1.0";

	/** Profile name (for identification) */
	profile: string;

	/** Role definitions (built-in or custom) */
	roles: Record<RoleId, ExtendedRoleConfig>;

	/** Extension definitions */
	extensions?: Record<string, ExtensionConfig>;

	/** Steering configuration */
	steering?: SteeringConfig;

	/** Auto-process ready tasks (false = interactive PM mode) */
	autoProcessReadyTasks?: boolean;
}

/**
 * Resolved role after config validation and resource loading.
 * Contains the complete configuration for a role including capabilities,
 * resolved prompt and extension paths, and permissions.
 */
export interface ResolvedRole {
	/** Role identifier */
	id: RoleId;

	/** Role configuration from workflow config */
	config: ExtendedRoleConfig;

	/** Resolved capabilities (from config or defaults) */
	capabilities: {
		category: RoleCategory;
		rendering: RenderingStyle;
		canModifyFiles: boolean;
		canCloseTask: boolean;
		canAdvanceLifecycle: boolean;
		canSpawn: RoleId[];
	};

	/** Resolved path to prompt file (null if no prompt) */
	promptPath: string | null;

	/** Resolved paths to extension files */
	extensionPaths: string[];

	/** Permissions for this role (can be overridden via env var) */
	permissions?: RolePermissions;
}

/**
 * Permissions for a role.
 * Controls what tools, bash commands, and roles can be used/spawned.
 * This is defense-in-depth, not a security boundary.
 */
export interface RolePermissions {
	/** Allowed tool names (whitelist) */
	tools: string[];

	/** Allowed bash commands (whitelist) */
	bash: string[];

	/** Roles this role can spawn (whitelist) */
	spawns: RoleId[];
}

/**
 * Validation result from RoleRegistry.validateConfig().
 */
export interface ValidationResult {
	/** Whether config is valid */
	valid: boolean;

	/** List of validation errors (empty if valid) */
	errors: string[];

	/** List of validation warnings (non-fatal issues) */
	warnings: string[];
}

/**
 * Role registry interface for runtime role management.
 */
export interface RoleRegistry {
	/** Check if a role is registered */
	has(roleId: RoleId): boolean;

	/** Get resolved role configuration */
	get(roleId: RoleId): ResolvedRole | undefined;

	/** List all registered role IDs */
	all(): RoleId[];

	/** Validate a workflow config */
	validateConfig(config: WorkflowConfig): ValidationResult;

	/** Load and resolve all roles from config */
	loadConfig(config: WorkflowConfig): Promise<ValidationResult>;
}
