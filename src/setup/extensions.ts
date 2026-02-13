import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AGENT_EXTENSION_FILENAMES, SINGULARITY_EXTENSION_FILENAMES } from "../config/constants";

export function getSrcDir(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function getAgentsExtensionsDir(srcDir = getSrcDir()): string {
	return path.resolve(srcDir, "agents", "extensions");
}

function resolveAgentExtensionPath(filename: string, srcDir = getSrcDir()): string {
	return path.resolve(getAgentsExtensionsDir(srcDir), filename);
}

export function resolveSingularityExtensionCandidates(srcDir = getSrcDir()): {
	candidates: string[];
	singularityGuardExtensionPath: string;
} {
	return {
		candidates: SINGULARITY_EXTENSION_FILENAMES.map(filename => resolveAgentExtensionPath(filename, srcDir)),
		singularityGuardExtensionPath: resolveAgentExtensionPath(AGENT_EXTENSION_FILENAMES.singularityToolGuard, srcDir),
	};
}

function createExtensionProbeApi(): any {
	const Type = {
		Object: () => ({}),
		String: () => ({}),
		Optional: (value: unknown) => value,
		Union: () => ({}),
		Literal: () => ({}),
		Array: () => ({}),
		Number: () => ({}),
		Boolean: () => ({}),
	};

	return {
		on: () => {
			// noop
		},
		registerTool: () => {
			// noop
		},
		typebox: { Type },
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
}

export async function probeExtensionLoad(extPath: string): Promise<{ ok: boolean; reason?: string }> {
	const probeUrl =
		`${pathToFileURL(extPath).href}?oms_probe=` + `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

	let mod: unknown;
	try {
		mod = await import(probeUrl);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `import failed: ${message}` };
	}

	const factory = (mod as { default?: unknown }).default;
	if (typeof factory !== "function") {
		return { ok: false, reason: "missing default export function" };
	}

	try {
		await (factory as (api: any) => unknown)(createExtensionProbeApi());
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `init failed: ${message}` };
	}

	return { ok: true };
}
