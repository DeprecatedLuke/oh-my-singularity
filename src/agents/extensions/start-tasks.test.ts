import { describe, expect, test } from "bun:test";

import startTasksExtension from "./start-tasks";
import type { ToolDefinition, ToolTheme, TypeBuilder } from "./types";

function createMockTypebox(): TypeBuilder {
	return {
		Object: (shape: Record<string, unknown>) => shape,
		String: () => ({}),
		Optional: <T>(value: T) => value,
		Union: (_schemas: unknown[]) => ({}),
		Literal: (_value: string | number | boolean) => ({}),
		Number: () => ({}),
		Boolean: () => ({}),
		Array: (_itemSchema: unknown) => [],
	};
}

const theme: ToolTheme = {
	fg: (_scope: string, text: string) => text,
	styledSymbol: (_name: string, _color: string) => "●",
	sep: { dot: "·" },
	spinnerFrames: ["⠋", "⠙", "⠹"],
};

async function registerStartTasksTool(): Promise<ToolDefinition> {
	let registeredTool: ToolDefinition | null = null;

	await startTasksExtension({
		typebox: { Type: createMockTypebox() },
		registerTool: (tool: ToolDefinition) => {
			registeredTool = tool;
		},
		on: () => {
			// noop
		},
	});

	const tool = registeredTool as ToolDefinition | null;
	if (!tool) throw new Error("start_tasks tool was not registered");
	return tool;
}

describe("start_tasks extension render status", () => {
	test("shows 'Start Tasks' with count in pending state", async () => {
		const tool = await registerStartTasksTool();
		if (!tool.renderCall) throw new Error("start_tasks renderCall was not registered");

		const lines = tool.renderCall({ count: 2 }, { expanded: false, isPartial: true }, theme).render(120);

		expect(lines[0]).toContain("Start Tasks");
		expect(lines.join("\n")).toContain("count: 2");
	});

	test("shows result summary after renderResult captures state", async () => {
		const tool = await registerStartTasksTool();
		if (!tool.renderCall) throw new Error("start_tasks renderCall was not registered");
		if (!tool.renderResult) throw new Error("start_tasks renderResult was not registered");

		// Create the call component (captures shared state reference)
		const callComponent = tool.renderCall({ count: 2 }, { expanded: false, isPartial: false }, theme);

		// Simulate result arriving: renderResult captures state
		tool.renderResult({ content: [{ type: "text", text: "OK" }] }, { expanded: false, isPartial: false }, theme);

		// Now render the call component — should see the result
		const lines = callComponent.render(120);

		expect(lines[0]).toContain("Started Tasks");
		expect(lines[0]).toContain("count: 2");
	});

	test("keeps renderResult empty for ok summary", async () => {
		const tool = await registerStartTasksTool();
		if (!tool.renderResult) throw new Error("start_tasks renderResult was not registered");

		const lines = tool
			.renderResult({ content: [{ type: "text", text: " OK " }] }, { expanded: false, isPartial: false }, theme)
			.render(120);

		expect(lines).toEqual([]);
	});
});
