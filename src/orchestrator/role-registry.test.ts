import { beforeEach, describe, expect, it } from "bun:test";
import type { WorkflowConfig } from "../types/workflow-config";
import { RoleRegistry } from "./role-registry";

describe("RoleRegistry", () => {
	let registry: RoleRegistry;

	beforeEach(() => {
		registry = new RoleRegistry();
	});

	describe("validateConfig", () => {
		it("accepts valid minimal config", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					worker: {},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
		});

		it("rejects missing version", () => {
			const config: Partial<WorkflowConfig> = {
				profile: "test",
				roles: { worker: {} },
			};

			const result = registry.validateConfig(config as WorkflowConfig);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("version"))).toBe(true);
		});

		it("rejects missing profile", () => {
			const config: Partial<WorkflowConfig> = {
				version: "1.0",
				roles: { worker: {} },
			};

			const result = registry.validateConfig(config as WorkflowConfig);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("profile"))).toBe(true);
		});

		it("rejects missing roles", () => {
			const config: Partial<WorkflowConfig> = {
				version: "1.0",
				profile: "test",
			};

			const result = registry.validateConfig(config as WorkflowConfig);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("roles"))).toBe(true);
		});

		it("rejects empty roles", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("at least one role"))).toBe(true);
		});

		it("rejects invalid category", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					custom: {
						category: "invalid" as any,
					},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("category"))).toBe(true);
		});

		it("rejects invalid rendering", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					custom: {
						rendering: "invalid" as any,
					},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("rendering"))).toBe(true);
		});

		it("rejects non-boolean canModifyFiles", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					custom: {
						canModifyFiles: "true" as any,
					},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("canModifyFiles"))).toBe(true);
		});

		it("rejects canSpawn referencing unknown role", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					custom: {
						canSpawn: ["unknown-role"],
					},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("unknown-role"))).toBe(true);
		});

		it("detects circular spawn dependencies", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					roleA: {
						canSpawn: ["roleB"],
					},
					roleB: {
						canSpawn: ["roleA"],
					},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("Circular"))).toBe(true);
		});

		it("validates steering config", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: { worker: {} },
				steering: {
					enabled: true,
					intervalMs: 0, // invalid
					roleId: "steering",
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("intervalMs"))).toBe(true);
		});

		it("validates extension config", () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: { worker: {} },
				extensions: {
					myExt: {
						path: "", // invalid
					},
				},
			};

			const result = registry.validateConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("path"))).toBe(true);
		});
	});

	describe("has and get", () => {
		it("has returns false for unloaded roles", () => {
			expect(registry.has("worker")).toBe(false);
		});

		it("get returns undefined for unloaded roles", () => {
			expect(registry.get("worker")).toBeUndefined();
		});
	});

	describe("all", () => {
		it("returns empty array for unloaded registry", () => {
			expect(registry.all()).toHaveLength(0);
		});
	});

	describe("loadConfig", () => {
		it("rejects invalid config during load", async () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					worker: {
						category: "invalid" as any,
					},
				},
			};

			const result = await registry.loadConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});

		it("loads built-in role", async () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					worker: {},
				},
			};

			const result = await registry.loadConfig(config);
			expect(result.valid).toBe(true);
			expect(registry.has("worker")).toBe(true);

			const resolved = registry.get("worker");
			expect(resolved).toBeDefined();
			expect(resolved!.id).toBe("worker");
			expect(resolved!.capabilities.category).toBe("implementer");
			expect(resolved!.capabilities.canModifyFiles).toBe(true);
		});

		it("loads custom role with defaults", async () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					custom: {
						category: "implementer",
						canModifyFiles: false,
					},
				},
			};

			const result = await registry.loadConfig(config);
			expect(result.valid).toBe(true);
			expect(registry.has("custom")).toBe(true);

			const resolved = registry.get("custom");
			expect(resolved).toBeDefined();
			expect(resolved!.capabilities.category).toBe("implementer");
			expect(resolved!.capabilities.canModifyFiles).toBe(false);
			expect(resolved!.capabilities.rendering).toBe("default"); // custom role default
		});

		it("returns error for missing extension", async () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					custom: {
						extensions: ["nonexistent-extension"],
					},
				},
			};

			const result = await registry.loadConfig(config);
			expect(result.valid).toBe(false);
			expect(result.errors.some(e => e.includes("extension"))).toBe(true);
		});

		it("loads multiple roles", async () => {
			const config: WorkflowConfig = {
				version: "1.0",
				profile: "test",
				roles: {
					worker: {},
					finisher: {},
					issuer: {},
				},
			};

			const result = await registry.loadConfig(config);
			expect(result.valid).toBe(true);
			expect(registry.all()).toHaveLength(3);
		});
	});
});
