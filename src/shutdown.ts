import fs from "node:fs";
import type net from "node:net";
import type { AgentRegistry } from "./agents/registry";
import { OmsRpcClient } from "./agents/rpc-wrapper";
import type { AgentLoop } from "./loop/agent-loop";
import type { TaskPollerLike } from "./tasks/poller";
import type { OmsTuiApp } from "./tui/app";
import { logger } from "./utils";

function trackedRpcClients(registry: AgentRegistry): OmsRpcClient[] {
	const out: OmsRpcClient[] = [];
	const seen = new Set<OmsRpcClient>();

	for (const agent of registry.getAll()) {
		const rpc = agent.rpc;
		if (!(rpc instanceof OmsRpcClient)) continue;
		if (seen.has(rpc)) continue;
		seen.add(rpc);
		out.push(rpc);
	}

	return out;
}

function forceKillTrackedAgents(registry: AgentRegistry): void {
	for (const rpc of trackedRpcClients(registry)) {
		try {
			rpc.forceKill();
		} catch (err) {
			logger.debug("shutdown.ts: best-effort failure after rpc.forceKill();", { err });
		}
	}
}

async function stopTrackedAgentsGracefully(registry: AgentRegistry, timeoutMs = 2_000): Promise<void> {
	await Promise.all(
		trackedRpcClients(registry).map(async rpc => {
			try {
				await rpc.stop({ timeoutMs });
			} catch (err) {
				logger.debug("shutdown.ts: best-effort failure after await rpc.stop({ timeoutMs });", { err });
			}
		}),
	);
}

export function setupShutdownHandlers(opts: {
	registry: AgentRegistry;
	app: OmsTuiApp;
	poller: TaskPollerLike;
	singularitySockPath: string;
	onBeforeExit?: () => Promise<void> | void;
	getLoop: () => AgentLoop | null;
	getIpcServer: () => net.Server | null;
}): {
	shutdown: (code: number, options?: { force?: boolean }) => Promise<void>;
	handleSignal: (code: number) => void;
	isShuttingDown: () => boolean;
} {
	let shuttingDown = false;

	const shutdown = async (code: number, options?: { force?: boolean }): Promise<void> => {
		if (options?.force) {
			forceKillTrackedAgents(opts.registry);
			process.exit(code);
			return;
		}
		if (shuttingDown) return;
		shuttingDown = true;
		const cleanup = (async () => {
			try {
				opts.getIpcServer()?.close();
			} catch (err) {
				logger.debug("shutdown.ts: best-effort failure after opts.getIpcServer()?.close();", { err });
			}
			try {
				if (fs.existsSync(opts.singularitySockPath)) fs.unlinkSync(opts.singularitySockPath);
			} catch (err) {
				logger.debug(
					"shutdown.ts: best-effort failure after if (fs.existsSync(opts.singularitySockPath)) fs.unlinkSync(opts.singularitySockPath);",
					{ err },
				);
			}
			try {
				opts.poller.stop();
			} catch (err) {
				logger.debug("shutdown.ts: best-effort failure after opts.poller.stop();", { err });
			}

			try {
				await opts.getLoop()?.stop();
			} catch (err) {
				logger.debug("shutdown.ts: best-effort failure after await opts.getLoop()?.stop();", { err });
			}

			await stopTrackedAgentsGracefully(opts.registry, 2_000);
			try {
				await opts.onBeforeExit?.();
			} catch (err) {
				logger.debug("shutdown.ts: best-effort failure after await opts.onBeforeExit?.();", { err });
			}
		})();

		// Never hang on shutdown: force-kill tracked agents after a short grace period.
		await Promise.race([cleanup, new Promise<void>(resolve => setTimeout(resolve, 3_000))]);

		forceKillTrackedAgents(opts.registry);
		process.exit(code);
	};

	const requestShutdown = (code: number, options?: { force?: boolean }) => {
		void shutdown(code, options);
	};

	const handleSignal = (code: number) => {
		if (shuttingDown) {
			forceKillTrackedAgents(opts.registry);
			process.exit(code);
			return;
		}
		if (code === 130) {
			opts.app.quit();
			return;
		}
		// Best-effort: stop TUI then shutdown loop.
		try {
			opts.app.stop();
		} catch (err) {
			logger.debug("shutdown.ts: best-effort failure after opts.app.stop();", { err });
		}
		requestShutdown(code);
	};

	process.on("SIGINT", () => {
		handleSignal(130);
	});

	process.on("SIGTERM", () => {
		handleSignal(143);
	});

	process.on("beforeExit", code => {
		if (shuttingDown) return;
		requestShutdown(typeof code === "number" ? code : 0);
	});

	process.on("exit", () => {
		forceKillTrackedAgents(opts.registry);
	});

	return {
		shutdown,
		handleSignal,
		isShuttingDown: () => shuttingDown,
	};
}
