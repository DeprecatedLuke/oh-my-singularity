import { describe, expect, it } from "bun:test";
import { type BuiltInRole, isBuiltInRole, type RoleId } from "./types";

describe("isBuiltInRole type guard", () => {
	it("returns true for all built-in role strings", () => {
		const builtInRoles: BuiltInRole[] = [
			"singularity",
			"issuer",
			"worker",
			"designer-worker",
			"finisher",
			"steering",
		];

		for (const role of builtInRoles) {
			expect(isBuiltInRole(role)).toBe(true);
		}
	});

	it("returns false for custom role strings", () => {
		const customRoles = ["custom-role", "my-agent", "reviewer", "random-string", "123"];

		for (const role of customRoles) {
			expect(isBuiltInRole(role)).toBe(false);
		}
	});

	it("returns false for empty string", () => {
		expect(isBuiltInRole("")).toBe(false);
	});

	it("returns false for case-variant strings", () => {
		expect(isBuiltInRole("Worker")).toBe(false);
		expect(isBuiltInRole("WORKER")).toBe(false);
		expect(isBuiltInRole("Issuer")).toBe(false);
	});

	it("narrows type correctly in conditional", () => {
		const role: RoleId = "worker";
		if (isBuiltInRole(role)) {
			// role is now BuiltInRole
			const r: BuiltInRole = role; // should compile without error
			expect(r).toBe("worker");
		}
	});

	it("narrows to false for custom roles", () => {
		const role: RoleId = "custom-role";
		if (!isBuiltInRole(role)) {
			// Inside this block, we know it's not a BuiltInRole
			// TypeScript can't express "not BuiltInRole" so we use the negation
			expect(role).toBe("custom-role");
		}
	});
});
