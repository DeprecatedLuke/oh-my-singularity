import { describe, expect, it } from "bun:test";
import { getCapabilities, type RoleCapabilities, validateCapabilities } from "./capabilities";

describe("getCapabilities", () => {
	it("returns correct capabilities for singularity", () => {
		const caps = getCapabilities("singularity");
		expect(caps.category).toBe("orchestrator");
		expect(caps.rendering).toBe("default");
		expect(caps.canModifyFiles).toBe(true);
		expect(caps.canCloseTask).toBe(false);
		expect(caps.canAdvanceLifecycle).toBe(false);
		expect(caps.canSpawn).toEqual(["singularity", "issuer", "worker", "designer-worker", "finisher", "steering"]);
	});

	it("returns correct capabilities for issuer", () => {
		const caps = getCapabilities("issuer");
		expect(caps.category).toBe("scout");
		expect(caps.rendering).toBe("decision");
		expect(caps.canModifyFiles).toBe(false);
		expect(caps.canCloseTask).toBe(false);
		expect(caps.canAdvanceLifecycle).toBe(true);
		expect(caps.canSpawn).toEqual([]);
	});

	it("returns correct capabilities for worker", () => {
		const caps = getCapabilities("worker");
		expect(caps.category).toBe("implementer");
		expect(caps.rendering).toBe("implementation");
		expect(caps.canModifyFiles).toBe(true);
		expect(caps.canCloseTask).toBe(false);
		expect(caps.canAdvanceLifecycle).toBe(false);
		expect(caps.canSpawn).toEqual([]);
	});

	it("returns correct capabilities for designer-worker", () => {
		const caps = getCapabilities("designer-worker");
		expect(caps.category).toBe("implementer");
		expect(caps.rendering).toBe("implementation");
		expect(caps.canModifyFiles).toBe(true);
		expect(caps.canCloseTask).toBe(false);
		expect(caps.canAdvanceLifecycle).toBe(false);
		expect(caps.canSpawn).toEqual([]);
	});

	it("returns correct capabilities for finisher", () => {
		const caps = getCapabilities("finisher");
		expect(caps.category).toBe("verifier");
		expect(caps.rendering).toBe("implementation");
		expect(caps.canModifyFiles).toBe(false);
		expect(caps.canCloseTask).toBe(true);
		expect(caps.canAdvanceLifecycle).toBe(false);
		expect(caps.canSpawn).toEqual([]);
	});

	it("returns correct capabilities for steering", () => {
		const caps = getCapabilities("steering");
		expect(caps.category).toBe("supervisor");
		expect(caps.rendering).toBe("decision");
		expect(caps.canModifyFiles).toBe(false);
		expect(caps.canCloseTask).toBe(false);
		expect(caps.canAdvanceLifecycle).toBe(false);
		expect(caps.canSpawn).toEqual([]);
	});

	it("returns default capabilities for custom role", () => {
		const caps = getCapabilities("custom-role");
		expect(caps.category).toBe("implementer");
		expect(caps.rendering).toBe("default");
		expect(caps.canModifyFiles).toBe(true);
		expect(caps.canCloseTask).toBe(false);
		expect(caps.canAdvanceLifecycle).toBe(false);
		expect(caps.canSpawn).toEqual([]);
	});
});

describe("validateCapabilities", () => {
	const validCaps: RoleCapabilities = {
		category: "implementer",
		rendering: "default",
		canModifyFiles: true,
		canCloseTask: false,
		canAdvanceLifecycle: false,
		canSpawn: ["worker"],
	};

	it("accepts valid capability objects", () => {
		expect(validateCapabilities(validCaps)).toBe(true);
	});

	it("accepts all valid categories", () => {
		const categories = ["orchestrator", "scout", "implementer", "verifier", "supervisor"];
		for (const category of categories) {
			const caps = { ...validCaps, category: category as any };
			expect(validateCapabilities(caps)).toBe(true);
		}
	});

	it("accepts all valid rendering styles", () => {
		const styles = ["decision", "implementation", "default"];
		for (const style of styles) {
			const caps = { ...validCaps, rendering: style as any };
			expect(validateCapabilities(caps)).toBe(true);
		}
	});

	it("rejects invalid category", () => {
		const caps = { ...validCaps, category: "invalid" as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("rejects invalid rendering style", () => {
		const caps = { ...validCaps, rendering: "bad" as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("rejects null", () => {
		expect(validateCapabilities(null as any)).toBe(false);
	});

	it("rejects undefined", () => {
		expect(validateCapabilities(undefined as any)).toBe(false);
	});

	it("rejects non-object", () => {
		expect(validateCapabilities("string" as any)).toBe(false);
		expect(validateCapabilities(123 as any)).toBe(false);
	});

	it("rejects non-boolean canModifyFiles", () => {
		const caps = { ...validCaps, canModifyFiles: "true" as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("rejects non-boolean canCloseTask", () => {
		const caps = { ...validCaps, canCloseTask: 1 as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("rejects non-boolean canAdvanceLifecycle", () => {
		const caps = { ...validCaps, canAdvanceLifecycle: null as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("rejects non-array canSpawn", () => {
		const caps = { ...validCaps, canSpawn: "worker" as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("rejects canSpawn with non-string elements", () => {
		const caps = { ...validCaps, canSpawn: ["worker", 123] as any };
		expect(validateCapabilities(caps)).toBe(false);
	});

	it("accepts empty canSpawn array", () => {
		const caps = { ...validCaps, canSpawn: [] };
		expect(validateCapabilities(caps)).toBe(true);
	});

	it("accepts multiple elements in canSpawn", () => {
		const caps = { ...validCaps, canSpawn: ["worker", "finisher", "steering"] };
		expect(validateCapabilities(caps)).toBe(true);
	});
});
