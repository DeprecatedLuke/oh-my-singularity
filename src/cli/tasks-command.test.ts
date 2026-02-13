import { describe, expect, test } from "bun:test";

type CommandResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

async function streamToText(stream: ReadableStream | number | null | undefined): Promise<string> {
	if (!stream || typeof stream === "number") return "";
	return await new Response(stream).text();
}

async function runOms(args: string[]): Promise<CommandResult> {
	const proc = Bun.spawn({
		cmd: ["bun", "src/index.ts", ...args],
		cwd: process.cwd(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		streamToText(proc.stdout),
		streamToText(proc.stderr),
		proc.exited,
	]);

	return { exitCode, stdout, stderr };
}

describe("tasks command cli", () => {
	test("tasks without action prints command help instead of throwing parse error", async () => {
		const result = await runOms(["tasks"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Manage JSON task store maintenance operations");
		expect(result.stdout).toContain("COMMANDS");
		expect(result.stdout).toContain("prune");
		expect(result.stdout).toContain("clear");
		expect(result.stderr.trim()).toBe("");
	});
});
