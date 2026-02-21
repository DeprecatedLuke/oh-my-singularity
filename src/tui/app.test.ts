import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { OmsTuiApp } from "./app";
import { computeLayout } from "./layout";

type Listener = (...args: unknown[]) => void;

type FakeTerminal = {
	width: number;
	height: number;
	stdout?: {
		getWindowSize?: () => [number, number];
	};
	clear: () => void;
	moveTo: (x: number, y: number) => void;
	grabInput: (options: unknown) => void;
	fullscreen: (enable: boolean) => void;
	hideCursor: () => void;
	showCursor: () => void;
	styleReset: () => void;
	on: (event: string, listener: Listener) => void;
	off: (event: string, listener: Listener) => void;
	eraseLine: () => void;
	emit: (event: string, ...args: unknown[]) => void;
	writes: string[];
	(text: string): void;
};

function createFakeTerminal(width: number, height: number): FakeTerminal {
	const emitter = new EventEmitter();
	const writes: string[] = [];
	const term = ((text: string) => {
		writes.push(text);
	}) as unknown as FakeTerminal;

	term.width = width;
	term.height = height;
	term.clear = () => {
		// noop
	};
	term.moveTo = () => {
		// noop
	};
	term.grabInput = () => {
		// noop
	};
	term.fullscreen = () => {
		// noop
	};
	term.hideCursor = () => {
		// noop
	};
	term.showCursor = () => {
		// noop
	};
	term.styleReset = () => {
		// noop
	};
	term.on = (event: string, listener: Listener) => {
		emitter.on(event, listener);
	};
	term.off = (event: string, listener: Listener) => {
		emitter.off(event, listener);
	};
	term.eraseLine = () => {
		// noop
	};
	term.emit = (event: string, ...args: unknown[]) => {
		emitter.emit(event, ...args);
	};
	term.writes = writes;

	return term;
}

function innerSingularitySize(columns: number, rows: number): { cols: number; rows: number } {
	const layout = computeLayout(columns, rows, { systemHeightRatio: 0 });
	return {
		cols: Math.max(0, layout.singularity.width - 2),
		rows: Math.max(0, layout.singularity.height - 2),
	};
}

function patchWindowSize(stream: NodeJS.WriteStream, value: (() => [number, number]) | undefined): () => void {
	const streamObj = stream as NodeJS.WriteStream & { getWindowSize?: () => [number, number] };
	const descriptor = Object.getOwnPropertyDescriptor(streamObj, "getWindowSize");

	if (value) {
		Object.defineProperty(streamObj, "getWindowSize", {
			configurable: true,
			writable: true,
			value,
		});
	} else {
		Object.defineProperty(streamObj, "getWindowSize", {
			configurable: true,
			writable: true,
			value: undefined,
		});
	}

	return () => {
		if (descriptor) {
			Object.defineProperty(streamObj, "getWindowSize", descriptor);
			return;
		}
		Object.defineProperty(streamObj, "getWindowSize", {
			configurable: true,
			writable: true,
			value: undefined,
		});
	};
}

describe("OmsTuiApp resize reconciliation", () => {
	test("uses process stdout window size when resize payload is stale", () => {
		const term = createFakeTerminal(80, 24);
		term.stdout = { getWindowSize: () => [80, 24] };

		const resizeCalls: Array<{ cols: number; rows: number }> = [];
		const app = new OmsTuiApp(term);
		app.setPanes({
			singularity: {
				render: () => {
					// noop
				},
				resize: (cols: number, rows: number) => {
					resizeCalls.push({ cols, rows });
				},
			},
		});

		const restoreStdout = patchWindowSize(process.stdout, () => [120, 40]);
		const restoreStderr = patchWindowSize(process.stderr, undefined);
		try {
			app.start();
			term.emit("resize", 80, 24);

			expect(resizeCalls.at(-1)).toEqual(innerSingularitySize(120, 40));
		} finally {
			app.stop();
			restoreStdout();
			restoreStderr();
		}
	});

	test("handles SIGWINCH directly to re-layout when terminal-kit misses size", () => {
		const term = createFakeTerminal(80, 24);
		term.stdout = { getWindowSize: () => [80, 24] };

		const resizeCalls: Array<{ cols: number; rows: number }> = [];
		const app = new OmsTuiApp(term);
		app.setPanes({
			singularity: {
				render: () => {
					// noop
				},
				resize: (cols: number, rows: number) => {
					resizeCalls.push({ cols, rows });
				},
			},
		});

		const baselineSigwinchListeners = process.listenerCount("SIGWINCH");
		const restoreStdout = patchWindowSize(process.stdout, () => [101, 31]);
		const restoreStderr = patchWindowSize(process.stderr, undefined);
		try {
			app.start();
			process.emit("SIGWINCH");

			expect(resizeCalls.at(-1)).toEqual(innerSingularitySize(101, 31));
		} finally {
			app.stop();
			restoreStdout();
			restoreStderr();
		}

		expect(process.listenerCount("SIGWINCH")).toBe(baselineSigwinchListeners);
	});

	test("_refreshSize is called before getWindowSize so stale process.stdout does not overwrite correct term.stdout", () => {
		const term = createFakeTerminal(80, 24);
		// terminal-kit stream returns the NEW correct size (refreshed by terminal-kit's own SIGWINCH handler)
		term.stdout = { getWindowSize: () => [120, 40] };

		const resizeCalls: Array<{ cols: number; rows: number }> = [];
		const app = new OmsTuiApp(term);
		app.setPanes({
			singularity: {
				render: () => {},
				resize: (cols: number, rows: number) => {
					resizeCalls.push({ cols, rows });
				},
			},
		});

		// process.stdout.getWindowSize returns STALE [80, 24] until _refreshSize is called.
		// This models Bun's behavior: getWindowSize just returns [this.columns, this.rows]
		// without an ioctl, and _refreshSize is the only way to update those cached values.
		let processStdoutSize: [number, number] = [80, 24];
		const restoreStdout = patchWindowSize(process.stdout, () => processStdoutSize);
		const origRefreshSize = Object.getOwnPropertyDescriptor(process.stdout, "_refreshSize");
		Object.defineProperty(process.stdout, "_refreshSize", {
			configurable: true,
			writable: true,
			value: () => {
				processStdoutSize = [120, 40];
			},
		});
		const restoreStderr = patchWindowSize(process.stderr, undefined);

		try {
			app.start();
			// Simulate resize event with stale payload (80x24) — terminal-kit emits old dims
			term.emit("resize", 80, 24);

			// Without the _refreshSize fix, process.stdout returns stale [80, 24],
			// overwrites the correct [120, 40] from term.stdout, and cols===lastCols
			// causes an early return with no layout update.
			// With the fix, _refreshSize is called first, process.stdout returns [120, 40],
			// and resize proceeds correctly.
			expect(resizeCalls.length).toBeGreaterThan(0);
			expect(resizeCalls.at(-1)).toEqual(innerSingularitySize(120, 40));
		} finally {
			app.stop();
			restoreStdout();
			if (origRefreshSize) {
				Object.defineProperty(process.stdout, "_refreshSize", origRefreshSize);
			} else {
				delete (process.stdout as any)._refreshSize;
			}
			restoreStderr();
		}
	});
});
