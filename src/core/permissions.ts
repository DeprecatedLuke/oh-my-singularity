/**
 * Permission validation and utilities.
 * Defense-in-depth approach: permissions are advisory, not enforcing.
 */

import type { RolePermissions } from "../types/workflow-config";

/**
 * Default permissions for a role (all tools, basic bash, no spawns).
 */
export const DEFAULT_PERMISSIONS: RolePermissions = {
	tools: ["bash", "read", "edit", "write", "grep", "find", "lsp", "python", "notebook", "fetch", "web_search"],
	bash: ["git", "npm", "bun", "python", "node"],
	spawns: [],
};

/**
 * Validate that a RolePermissions object is well-formed.
 * All three arrays must be present and contain only strings.
 */
export function validatePermissions(perms: RolePermissions): boolean {
	if (!perms || typeof perms !== "object") {
		return false;
	}

	if (!Array.isArray(perms.tools) || !perms.tools.every(t => typeof t === "string")) {
		return false;
	}

	if (!Array.isArray(perms.bash) || !perms.bash.every(b => typeof b === "string")) {
		return false;
	}

	if (!Array.isArray(perms.spawns) || !perms.spawns.every(s => typeof s === "string")) {
		return false;
	}

	return true;
}

/**
 * Parse role permissions from JSON string (from env var).
 * Returns default permissions if parsing fails or env var is not set.
 */
export function parsePermissionsFromEnv(json?: string): RolePermissions {
	if (!json) {
		return { ...DEFAULT_PERMISSIONS };
	}

	try {
		const parsed = JSON.parse(json) as unknown;
		if (validatePermissions(parsed as RolePermissions)) {
			return parsed as RolePermissions;
		}
	} catch {
		// Ignore parse errors, return defaults
	}

	return { ...DEFAULT_PERMISSIONS };
}

/**
 * Check if a tool is allowed by permissions.
 */
export function isToolAllowed(tool: string, perms: RolePermissions): boolean {
	return perms.tools.includes(tool) || perms.tools.includes("*");
}

/**
 * Check if a bash command is allowed by permissions.
 */
export function isBashAllowed(command: string, perms: RolePermissions): boolean {
	return perms.bash.includes(command) || perms.bash.includes("*");
}

/**
 * Check if a role can be spawned.
 */
export function canSpawnRole(role: string, perms: RolePermissions): boolean {
	return perms.spawns.includes(role) || perms.spawns.includes("*");
}
