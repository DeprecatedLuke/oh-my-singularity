/**
 * Two-tier role system: built-in roles (exact type safety) + custom roles (extensibility).
 * Behavioral code switches on capabilities, not role names.
 */

/**
 * Built-in roles (exact string literals for type safety and runtime validation).
 * OMS core roles that are always available and have well-defined capabilities.
 */
export type BuiltInRole = "singularity" | "issuer" | "worker" | "designer-worker" | "finisher" | "steering";

/**
 * All role identifiers (built-in or custom).
 * Used for role names that may be user-defined in configuration.
 */
export type RoleId = string;

/**
 * Role categories for behavioral switching.
 * This is the semantic category that determines what a role can do.
 */
export type RoleCategory = "orchestrator" | "scout" | "implementer" | "verifier" | "supervisor";

/**
 * Rendering style for TUI output.
 * Determines how lifecycle events are formatted in the TUI.
 */
export type RenderingStyle = "decision" | "implementation" | "default";

/**
 * Capabilities for a role.
 * Behavioral code checks these capabilities instead of role names.
 */
export interface RoleCapabilities {
	/** Semantic category determines allowed actions and filters */
	category: RoleCategory;

	/** How lifecycle events are rendered in TUI */
	rendering: RenderingStyle;

	/** Can this role modify files via edit/write tools */
	canModifyFiles: boolean;

	/** Can this role close or update tasks */
	canCloseTask: boolean;

	/** Can this role call advance_lifecycle tool */
	canAdvanceLifecycle: boolean;

	/** Which roles this role can spawn (empty array = cannot spawn) */
	canSpawn: RoleId[];
}

/**
 * Role type for configuration: accepts built-in roles or any custom role string.
 * This uses the TypeScript pattern `Type | (string & {})` to allow exact type
 * checking for known values while accepting any string at runtime.
 */
export type AgentRole = BuiltInRole | (string & {});

/**
 * Type guard to narrow RoleId to BuiltInRole.
 * Use this to safely work with only the built-in roles.
 */
export function isBuiltInRole(role: RoleId): role is BuiltInRole {
	return ["singularity", "issuer", "worker", "designer-worker", "finisher", "steering"].includes(role);
}
