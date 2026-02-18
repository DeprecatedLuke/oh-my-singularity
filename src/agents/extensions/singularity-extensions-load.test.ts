import { describe, expect, test } from "bun:test";

describe("singularity extension modules", () => {
	test("interrupt/replace/tasks singularity extensions import cleanly", async () => {
		const modules = await Promise.all([
			import("./interrupt-agent.ts"),
			import("./replace-agent.ts"),
			import("./tasks-singularity.ts"),
			import("./tasks-command.ts"),
		]);

		for (const mod of modules) {
			expect(typeof mod.default).toBe("function");
		}
	});
});
