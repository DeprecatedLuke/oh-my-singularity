/**
 * Role capability lookup and validation.
 * Built-in roles have fixed capabilities; custom roles use defaults.
 */

import { isBuiltInRole, type RoleCapabilities, type RoleId } from "./types";

export type { RoleCapabilities } from "./types";

/**
 * Capability mappings for built-in roles.
 * These are the definitive capabilities for each role per PLAN.md design.
 */
const BUILT_IN_CAPABILITIES: Record<string, RoleCapabilities> = {
	singularity: {
		category: "orchestrator",
		rendering: "default",
		canModifyFiles: true,
		canCloseTask: false,
		canAdvanceLifecycle: false,
		canSpawn: ["singularity", "issuer", "worker", "designer-worker", "finisher", "steering"],
	},
	issuer: {
		category: "scout",
		rendering: "decision",
		canModifyFiles: false,
		canCloseTask: false,
		canAdvanceLifecycle: true,
		canSpawn: [],
	},
	worker: {
		category: "implementer",
		rendering: "implementation",
		canModifyFiles: true,
		canCloseTask: false,
		canAdvanceLifecycle: false,
		canSpawn: [],
	},
	"designer-worker": {
		category: "implementer",
		rendering: "implementation",
		canModifyFiles: true,
		canCloseTask: false,
		canAdvanceLifecycle: false,
		canSpawn: [],
	},
	finisher: {
		category: "verifier",
		rendering: "implementation",
		canModifyFiles: false,
		canCloseTask: true,
		canAdvanceLifecycle: false,
		canSpawn: [],
	},
	steering: {
		category: "supervisor",
		rendering: "decision",
		canModifyFiles: false,
		canCloseTask: false,
		canAdvanceLifecycle: false,
		canSpawn: [],
	},
};

/**
 * Get capabilities for any role (built-in or custom).
 *
 * Built-in roles return their fixed capabilities.
 * Custom roles return default capabilities (implementer with no spawn permissions).
 *
 * @param role Role ID (built-in or custom)
 * @returns Capabilities for this role
 */
export function getCapabilities(role: RoleId): RoleCapabilities {
	if (isBuiltInRole(role)) {
		const caps = BUILT_IN_CAPABILITIES[role];
		if (!caps) {
			throw new Error(`Unknown built-in role: ${role}`);
		}
		return caps;
	}

	// Custom roles use default capabilities
	return {
		category: "implementer",
		rendering: "default",
		canModifyFiles: true,
		canCloseTask: false,
		canAdvanceLifecycle: false,
		canSpawn: [],
	};
}

/**
 * Validate that a RoleCapabilities object is well-formed.
 * Checks that all required fields are present and have valid values.
 *
 * @param caps Capabilities to validate
 * @returns true if valid, false otherwise
 */
export function validateCapabilities(caps: RoleCapabilities): boolean {
	if (!caps || typeof caps !== "object") {
		return false;
	}

	const validCategories = ["orchestrator", "scout", "implementer", "verifier", "supervisor"];
	const validRenderingStyles = ["decision", "implementation", "default"];

	if (!validCategories.includes(caps.category)) {
		return false;
	}

	if (!validRenderingStyles.includes(caps.rendering)) {
		return false;
	}

	if (typeof caps.canModifyFiles !== "boolean") {
		return false;
	}

	if (typeof caps.canCloseTask !== "boolean") {
		return false;
	}

	if (typeof caps.canAdvanceLifecycle !== "boolean") {
		return false;
	}

	if (!Array.isArray(caps.canSpawn)) {
		return false;
	}

	// All elements of canSpawn must be strings
	if (!caps.canSpawn.every(role => typeof role === "string")) {
		return false;
	}

	return true;
}
