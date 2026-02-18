import fs from "node:fs";
import net from "node:net";
import { logger } from "../utils";

export function stringifyIpcResponse(value: unknown): string {
	if (value === undefined) return "ok";
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || "ok";
	}

	try {
		return JSON.stringify(value);
	} catch (err) {
		logger.debug("IPC: failed to stringify response payload; returning fallback 'ok'", { err });
		return "ok";
	}
}

export async function startOmsSingularityIpcServer(opts: {
	sockPath: string;
	onWake: (payload: unknown) => unknown | Promise<unknown>;
}): Promise<net.Server> {
	const sockPath = opts.sockPath;
	try {
		if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
	} catch (err) {
		logger.debug("IPC: failed to remove stale socket before bind", { sockPath, err });
	}
	return await new Promise<net.Server>((resolve, reject) => {
		const server = net.createServer({ allowHalfOpen: true }, socket => {
			let buf = "";
			let handled = false;
			socket.setEncoding("utf8");
			const flushLine = async (rawLine: string) => {
				if (handled) return;
				handled = true;
				const line = rawLine.trim();
				let responsePayload: unknown;
				if (line) {
					let payload: unknown = line;
					try {
						payload = JSON.parse(line);
					} catch (err) {
						logger.debug("IPC: incoming payload was not JSON; using raw line", { err });
					}

					try {
						responsePayload = await opts.onWake(payload);
					} catch (err) {
						logger.warn("IPC: wake handler failed; returning error payload", { err });
						responsePayload = { ok: false, error: "ipc handler failed" };
					}
				}
				const responseLine = stringifyIpcResponse(responsePayload);
				try {
					socket.end(`${responseLine}\n`);
				} catch (err) {
					logger.debug("IPC: failed to send response; socket likely closed", { err });
				}
			};
			socket.on("data", chunk => {
				if (handled) return;
				buf += chunk;
				const idx = buf.indexOf("\n");
				if (idx >= 0) {
					const line = buf.slice(0, idx);
					void flushLine(line);
				}
			});

			socket.on("end", () => {
				if (handled) return;
				void flushLine(buf);
			});
			socket.on("error", err => {
				logger.debug("IPC: socket error while handling request", { err });
			});
		});
		server.once("error", err => {
			reject(err);
		});
		server.listen(sockPath, () => {
			resolve(server);
		});
	});
}
