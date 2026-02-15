import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_WORKFLOW_CONFIG, loadWorkflowConfig } from "./config-loader";

describe("config-loader", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = `.oms-test-${Date.now()}`;
		await fs.mkdir(tempDir, { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test("no workflow config file defaults to autonomous mode", async () => {
		const config = await loadWorkflowConfig(tempDir);

		expect(config.profile ?? "").toEqual(DEFAULT_WORKFLOW_CONFIG.profile ?? "");
		expect(config.autoProcessReadyTasks).toEqual(true);
		expect(config.version).toEqual("1.0");
		expect(config.roles).toBeDefined();
	});

	test("defaults match pre-PR behavior (autonomous mode enabled)", async () => {
		const config = await loadWorkflowConfig(tempDir);

		// Verify that defaults enable autonomous mode (backward compatible)
		expect(config.autoProcessReadyTasks ?? false).toEqual(true);
	});

	test("loads config from JSON file when present", async () => {
		const configPath = path.join(tempDir, "workflow.json");
		const customConfig = {
			profile: "custom",
			autoProcessReadyTasks: false,
			roles: {
				"custom-role": { permissions: {} },
			},
		};

		await Bun.write(configPath, JSON.stringify(customConfig));
		const config = await loadWorkflowConfig(tempDir);

		expect(config.profile ?? "").toEqual("custom");
		expect(config.autoProcessReadyTasks ?? false).toEqual(false);
		expect(config.roles?.["custom-role"]).toBeDefined();
	});
});
