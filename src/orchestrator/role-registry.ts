/**
 * RoleRegistry: Central registry for role configuration, validation, and resource resolution.
 * Resolves prompts, extensions, and capabilities at startup with fail-fast error reporting.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCapabilities } from "../core/capabilities";
import { parsePermissionsFromEnv } from "../core/permissions";
import { isBuiltInRole, type RoleCapabilities, type RoleId } from "../core/types";
import { getSrcDir, probeExtensionLoad } from "../setup/extensions";
import type {
	ExtendedRoleConfig,
	RoleRegistry as IRoleRegistry,
	ResolvedRole,
	ValidationResult,
	WorkflowConfig,
} from "../types/workflow-config";

/**
 * RoleRegistry implementation.
 * Loads and validates workflow configuration, resolves resources (prompts, extensions),
 * and provides runtime role lookup.
 */
export class RoleRegistry implements IRoleRegistry {
	#roles = new Map<RoleId, ResolvedRole>();
	#srcDir: string;

	constructor(srcDir?: string) {
		this.#srcDir = srcDir ?? getSrcDir();
	}

	has(roleId: RoleId): boolean {
		return this.#roles.has(roleId);
	}

	get(roleId: RoleId): ResolvedRole | undefined {
		return this.#roles.get(roleId);
	}

	all(): RoleId[] {
		return Array.from(this.#roles.keys());
	}

	/**
	 * Validate configuration without loading extensions (fast check).
	 * Checks schema, role definitions, capability consistency.
	 */
	validateConfig(config: WorkflowConfig): ValidationResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		// Check required fields
		if (!config.version || config.version !== "1.0") {
			errors.push('config.version must be "1.0"');
		}

		if (!config.profile || typeof config.profile !== "string") {
			errors.push("config.profile is required and must be a string");
		}

		if (!config.roles || typeof config.roles !== "object") {
			errors.push("config.roles is required and must be an object");
		} else if (Object.keys(config.roles).length === 0) {
			errors.push("config.roles must define at least one role");
		}

		// Validate each role
		for (const [roleId, roleConfig] of Object.entries(config.roles ?? {})) {
			const roleErrors = this.#validateRoleConfig(roleId, roleConfig, config.roles ?? {});
			errors.push(...roleErrors);
		}

		// Check for circular spawn dependencies
		const circularErrors = this.#checkCircularSpawnDeps(config.roles ?? {});
		errors.push(...circularErrors);

		// Validate steering config if present
		if (config.steering) {
			if (typeof config.steering.enabled !== "boolean") {
				errors.push("config.steering.enabled must be a boolean");
			}
			if (typeof config.steering.intervalMs !== "number" || config.steering.intervalMs <= 0) {
				errors.push("config.steering.intervalMs must be a positive number");
			}
			if (!config.steering.roleId || typeof config.steering.roleId !== "string") {
				errors.push("config.steering.roleId must be a non-empty string");
			}
		}

		// Validate extension config if present
		if (config.extensions) {
			for (const [extName, extConfig] of Object.entries(config.extensions)) {
				if (!extConfig.path || typeof extConfig.path !== "string") {
					errors.push(`config.extensions["${extName}"].path must be a non-empty string`);
				}
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Load and resolve all roles from configuration.
	 * This is the full initialization that also validates extensions (slow).
	 */
	async loadConfig(config: WorkflowConfig): Promise<ValidationResult> {
		const validationResult = this.validateConfig(config);
		if (!validationResult.valid) {
			return validationResult;
		}

		const errors: string[] = [];
		const warnings: string[] = [];

		// Load each role
		for (const [roleId, roleConfig] of Object.entries(config.roles)) {
			try {
				const resolved = await this.#loadRole(roleId, roleConfig, config);
				this.#roles.set(roleId, resolved);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`Failed to load role "${roleId}": ${message}`);
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Validate a single role configuration.
	 * Returns array of error messages (empty if valid).
	 */
	#validateRoleConfig(
		roleId: RoleId,
		config: ExtendedRoleConfig,
		allRoles: Record<RoleId, ExtendedRoleConfig>,
	): string[] {
		const errors: string[] = [];

		// Check category validity if specified
		if (config.category) {
			const validCategories = ["orchestrator", "scout", "implementer", "verifier", "supervisor"];
			if (!validCategories.includes(config.category)) {
				errors.push(`roles["${roleId}"].category must be one of: ${validCategories.join(", ")}`);
			}
		}

		// Check rendering validity if specified
		if (config.rendering) {
			const validRenderingStyles = ["decision", "implementation", "default"];
			if (!validRenderingStyles.includes(config.rendering)) {
				errors.push(`roles["${roleId}"].rendering must be one of: ${validRenderingStyles.join(", ")}`);
			}
		}

		// Check canModifyFiles is boolean if specified
		if (config.canModifyFiles !== undefined && typeof config.canModifyFiles !== "boolean") {
			errors.push(`roles["${roleId}"].canModifyFiles must be a boolean`);
		}

		// Check canCloseTask is boolean if specified
		if (config.canCloseTask !== undefined && typeof config.canCloseTask !== "boolean") {
			errors.push(`roles["${roleId}"].canCloseTask must be a boolean`);
		}

		// Check canAdvanceLifecycle is boolean if specified
		if (config.canAdvanceLifecycle !== undefined && typeof config.canAdvanceLifecycle !== "boolean") {
			errors.push(`roles["${roleId}"].canAdvanceLifecycle must be a boolean`);
		}

		// Check canSpawn is array of strings if specified
		if (config.canSpawn !== undefined) {
			if (!Array.isArray(config.canSpawn)) {
				errors.push(`roles["${roleId}"].canSpawn must be an array`);
			} else {
				for (const spawnRole of config.canSpawn) {
					if (typeof spawnRole !== "string") {
						errors.push(`roles["${roleId}"].canSpawn must contain only strings`);
						break;
					}
					if (!allRoles[spawnRole]) {
						errors.push(`roles["${roleId}"].canSpawn references unknown role "${spawnRole}"`);
					}
				}
			}
		}

		// Check extensions is array of strings if specified
		if (config.extensions !== undefined) {
			if (!Array.isArray(config.extensions)) {
				errors.push(`roles["${roleId}"].extensions must be an array`);
			} else {
				for (const ext of config.extensions) {
					if (typeof ext !== "string") {
						errors.push(`roles["${roleId}"].extensions must contain only strings`);
						break;
					}
				}
			}
		}

		// Check prompt is string if specified
		if (config.prompt !== undefined && typeof config.prompt !== "string") {
			errors.push(`roles["${roleId}"].prompt must be a string`);
		}

		// Check color is string if specified
		if (config.color !== undefined && typeof config.color !== "string") {
			errors.push(`roles["${roleId}"].color must be a string`);
		}

		return errors;
	}

	/**
	 * Check for circular spawn dependencies.
	 * Returns array of error messages (empty if valid).
	 */
	#checkCircularSpawnDeps(allRoles: Record<RoleId, ExtendedRoleConfig>): string[] {
		const errors: string[] = [];

		for (const [roleId, config] of Object.entries(allRoles)) {
			const canSpawn = config.canSpawn ?? [];
			for (const spawnRole of canSpawn) {
				// Check if spawnRole can spawn roleId (direct circular dependency)
				const spawnConfig = allRoles[spawnRole];
				if (spawnConfig && (spawnConfig.canSpawn ?? []).includes(roleId)) {
					errors.push(`Circular spawn dependency: "${roleId}" ↔ "${spawnRole}"`);
				}
			}
		}

		return errors;
	}

	/**
	 * Load a single role: resolve capabilities, prompts, and extensions.
	 */
	async #loadRole(roleId: RoleId, config: ExtendedRoleConfig, workflowConfig: WorkflowConfig): Promise<ResolvedRole> {
		// Resolve capabilities (from config or built-in defaults)
		const capabilities = this.#resolveCapabilities(roleId, config);

		// Resolve prompt path
		const promptPath = await this.#resolvePrompt(roleId, config);

		// Resolve and validate extension paths
		const extensionPaths = await this.#resolveExtensions(config, workflowConfig);

		// Parse permissions from env var if present
		const permissions = parsePermissionsFromEnv(process.env[`OMS_ROLE_PERMISSIONS_${roleId.toUpperCase()}`]);

		return {
			id: roleId,
			config,
			capabilities,
			promptPath,
			extensionPaths,
			permissions,
		};
	}

	/**
	 * Resolve capabilities for a role.
	 * Built-in roles use fixed capabilities, custom roles use config + defaults.
	 */
	#resolveCapabilities(roleId: RoleId, config: ExtendedRoleConfig): RoleCapabilities {
		// For built-in roles, return fixed capabilities from Phase 1
		if (isBuiltInRole(roleId)) {
			return getCapabilities(roleId);
		}

		// For custom roles, merge config with defaults
		const defaults = getCapabilities(roleId); // This returns custom defaults
		return {
			category: config.category ?? defaults.category,
			rendering: config.rendering ?? defaults.rendering,
			canModifyFiles: config.canModifyFiles ?? defaults.canModifyFiles,
			canCloseTask: config.canCloseTask ?? defaults.canCloseTask,
			canAdvanceLifecycle: config.canAdvanceLifecycle ?? defaults.canAdvanceLifecycle,
			canSpawn: config.canSpawn ?? defaults.canSpawn,
		};
	}

	/**
	 * Resolve prompt path for a role.
	 * Order: config.prompt → built-in → null
	 */
	async #resolvePrompt(roleId: RoleId, config: ExtendedRoleConfig): Promise<string | null> {
		// If config specifies a prompt, use it
		if (config.prompt) {
			// Try as absolute path first, then relative to cwd
			try {
				await fs.stat(config.prompt);
				return path.resolve(config.prompt);
			} catch {
				// Try relative to cwd
				const relative = path.resolve(config.prompt);
				try {
					await fs.stat(relative);
					return relative;
				} catch {
					throw new Error(`prompt path not found: ${config.prompt}`);
				}
			}
		}

		// Try built-in prompt
		const builtInPath = path.resolve(this.#srcDir, "agents", "prompts", `${roleId}.md`);
		try {
			await fs.stat(builtInPath);
			return builtInPath;
		} catch {
			// No built-in prompt, which is ok
		}

		return null;
	}

	/**
	 * Resolve and validate extension paths for a role.
	 * Order: built-in → relative → absolute → error
	 */
	async #resolveExtensions(config: ExtendedRoleConfig, workflowConfig: WorkflowConfig): Promise<string[]> {
		const extensions = config.extensions ?? [];
		const resolved: string[] = [];

		for (const ext of extensions) {
			const extPath = await this.#resolveExtensionPath(ext, workflowConfig);
			resolved.push(extPath);

			// Validate extension can be loaded
			const probe = await probeExtensionLoad(extPath);
			if (!probe.ok) {
				throw new Error(`extension "${ext}" failed validation: ${probe.reason}`);
			}
		}

		return resolved;
	}

	/**
	 * Resolve a single extension path.
	 * Order: built-in → relative → absolute → error
	 */
	async #resolveExtensionPath(ext: string, workflowConfig: WorkflowConfig): Promise<string> {
		// Check if it's a reference to a named extension in config.extensions
		if (workflowConfig.extensions?.[ext]) {
			return this.#resolveExtensionPath(workflowConfig.extensions[ext].path, workflowConfig);
		}

		// Try as built-in extension
		const builtInPath = path.resolve(this.#srcDir, "agents", "extensions", `${ext}.ts`);
		try {
			await fs.stat(builtInPath);
			return builtInPath;
		} catch {
			// Not built-in, continue
		}

		// Try as relative path from cwd
		const relativePath = path.resolve(ext);
		try {
			await fs.stat(relativePath);
			return relativePath;
		} catch {
			// Not found as relative, continue
		}

		// Try as absolute path
		if (path.isAbsolute(ext)) {
			try {
				await fs.stat(ext);
				return ext;
			} catch {
				throw new Error(`extension not found: ${ext}`);
			}
		}

		throw new Error(`extension not found: ${ext} (tried built-in, relative, and absolute paths)`);
	}
}
