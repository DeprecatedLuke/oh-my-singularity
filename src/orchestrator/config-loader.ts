/**
 * Config loader: Load workflow configuration from files with merge order.
 * Merge order: defaults → json → yml → env vars
 */

import * as path from "node:path";
import type { WorkflowConfig } from "../types/workflow-config";
import * as logger from "../utils/logger";

/**
 * Default workflow configuration.
 * Empty profile with no roles defined (requires config file).
 */
export const DEFAULT_WORKFLOW_CONFIG: Partial<WorkflowConfig> = {
	version: "1.0",
	profile: "default",
	roles: {},
	autoProcessReadyTasks: true,
};

/**
 * Load workflow configuration from files.
 * Tries to load from:
 * 1. .oms/workflow.json (project-level)
 * 2. .oms/workflow.yml (project-level)
 * Environment variables can override (OMS_WORKFLOW_* prefix)
 */
export async function loadWorkflowConfig(configDir = ".oms"): Promise<WorkflowConfig> {
	const config: Partial<WorkflowConfig> = { ...DEFAULT_WORKFLOW_CONFIG };

	// Try to load from JSON file
	const jsonPath = path.resolve(configDir, "workflow.json");
	try {
		const jsonContent = await Bun.file(jsonPath).text();
		const jsonConfig = JSON.parse(jsonContent) as Partial<WorkflowConfig>;
		Object.assign(config, jsonConfig);
		logger.debug("Loaded workflow config from JSON", { path: jsonPath });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("Failed to load workflow.json", { path: jsonPath, error: String(err) });
		}
	}

	// Try to load from YAML file (if available)
	const ymlPath = path.resolve(configDir, "workflow.yml");
	try {
		const ymlContent = await Bun.file(ymlPath).text();
		const ymlConfig = parseYaml(ymlContent) as Partial<WorkflowConfig>;
		if (ymlConfig) {
			mergeConfig(config, ymlConfig);
			logger.debug("Loaded workflow config from YAML", { path: ymlPath });
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.debug("Failed to load workflow.yml", { path: ymlPath, error: String(err) });
		}
	}

	// Override from environment variables
	const envOverride = loadConfigFromEnvironment();
	if (envOverride) {
		mergeConfig(config, envOverride);
		logger.debug("Loaded workflow config from environment");
	}

	// Ensure required fields
	if (!config.version || !config.profile || !config.roles) {
		throw new Error(
			"Invalid workflow config: missing required fields (version, profile, roles). " +
				"Create .oms/workflow.json or .oms/workflow.yml",
		);
	}

	return config as WorkflowConfig;
}

/**
 * Parse YAML content (simple implementation).
 * Only handles basic YAML structure needed for workflow config.
 * For complex YAML, users should use JSON or implement full YAML parser.
 */
function parseYaml(_content: string): Record<string, unknown> | null {
	// This is a simple YAML parser for basic structures
	// For production, use a proper YAML library
	// For now, we'll return null to indicate YAML support is not implemented
	// Users can convert YAML to JSON manually
	logger.warn("YAML parsing not yet implemented; use workflow.json instead");
	return null;
}

/**
 * Merge source config into target config.
 * Source values override target values (shallow merge).
 */
function mergeConfig(target: Partial<WorkflowConfig>, source: Partial<WorkflowConfig>): void {
	if (source.version) target.version = source.version;
	if (source.profile) target.profile = source.profile;
	if (source.roles) {
		if (!target.roles) target.roles = {};
		Object.assign(target.roles, source.roles);
	}
	if (source.extensions) {
		if (!target.extensions) target.extensions = {};
		Object.assign(target.extensions, source.extensions);
	}
	if (source.steering) target.steering = source.steering;
	if (typeof source.autoProcessReadyTasks === "boolean") target.autoProcessReadyTasks = source.autoProcessReadyTasks;
}

/**
 * Load workflow config overrides from environment variables.
 * Supports:
 * - OMS_WORKFLOW_PROFILE: Override profile name
 * - OMS_WORKFLOW_AUTO_PROCESS: Override autoProcessReadyTasks (true/false)
 */
function loadConfigFromEnvironment(): Partial<WorkflowConfig> | null {
	const overrides: Partial<WorkflowConfig> = {};
	let hasOverrides = false;

	const profile = process.env.OMS_WORKFLOW_PROFILE;
	if (profile) {
		overrides.profile = profile;
		hasOverrides = true;
	}

	const autoProcess = process.env.OMS_WORKFLOW_AUTO_PROCESS;
	if (autoProcess) {
		overrides.autoProcessReadyTasks = autoProcess === "true" || autoProcess === "1";
		hasOverrides = true;
	}

	return hasOverrides ? overrides : null;
}
