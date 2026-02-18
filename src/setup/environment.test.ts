import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadOmsConfigOverride, saveOmsConfigOverride } from "./environment";

type SetupFixture = {
	configPath: string;
};

async function withFixture<T>(run: (fixture: SetupFixture) => Promise<T>): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oms-env-test-"));
	const configPath = path.join(tempDir, ".oms", "config.json");
	try {
		return await run({ configPath });
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

describe("saveOmsConfigOverride", () => {
	test("merges overrides into existing config instead of overwriting", async () => {
		await withFixture(async ({ configPath }) => {
			const existing = {
				pollIntervalMs: 250,
				layout: {
					tasksHeightRatio: 0.5,
					agentsWidthRatio: 0.2,
					systemHeightRatio: 0.2,
				},
				roles: {
					worker: {
						model: "codex",
						thinking: "medium",
					},
					issuer: {
						model: "sonnet",
						thinking: "low",
					},
				},
			};
			await fs.mkdir(path.dirname(configPath), { recursive: true });
			await fs.writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

			await saveOmsConfigOverride(configPath, {
				maxWorkers: 12,
				layout: {
					tasksHeightRatio: 0.9,
				},
				roles: {
					worker: {
						thinking: "xhigh",
					},
				},
			});

			const persisted = loadOmsConfigOverride(configPath);
			expect(persisted).toEqual({
				pollIntervalMs: 250,
				maxWorkers: 12,
				layout: {
					tasksHeightRatio: 0.9,
					agentsWidthRatio: 0.2,
					systemHeightRatio: 0.2,
				},
				roles: {
					worker: {
						model: "codex",
						thinking: "xhigh",
					},
					issuer: {
						model: "sonnet",
						thinking: "low",
					},
				},
			});
		});
	});

	test("preserves previous settings across multiple saves", async () => {
		await withFixture(async ({ configPath }) => {
			await saveOmsConfigOverride(configPath, {
				pollIntervalMs: 777,
			});
			await saveOmsConfigOverride(configPath, {
				layout: {
					tasksHeightRatio: 0.77,
				},
			});

			expect(loadOmsConfigOverride(configPath)).toEqual({
				pollIntervalMs: 777,
				layout: {
					tasksHeightRatio: 0.77,
				},
			});
		});
	});

	test("creates config file if missing", async () => {
		await withFixture(async ({ configPath }) => {
			await saveOmsConfigOverride(configPath, {
				pollIntervalMs: 1_234,
			});

			expect(loadOmsConfigOverride(configPath)).toEqual({ pollIntervalMs: 1_234 });
		});
	});
});
