import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "../utils";

const EVENT_LOOP_SAMPLE_INTERVAL_MS = 100;
const EVENT_LOOP_LAG_SPIKE_MS = 50;

// ---- Types ----

export type PhaseTimings = Record<string, number>; // phase name → ms

export type FrameMetrics = {
	ts: number; // epoch ms when frame started
	totalMs: number; // total frame time
	phases: PhaseTimings; // per-phase breakdown
	bordersRedrawn: boolean;
	bufferLength: number; // chars written to terminal
	queueDepth: number; // coalesced redraw requests
};

type EventLoopLagRecord = {
	type: "event-loop-lag";
	ts: number;
	expectedTs: number;
	driftMs: number;
};

type EventLoopLagSummary = {
	samples: number;
	avgMs: number;
	p95Ms: number;
	maxMs: number;
	spikesOverThreshold: number;
};
type FrameSummary = {
	type: "summary";
	frames: number;
	totalMs: { avg: number; p50: number; p95: number; max: number };
	slowestPhases: { phase: string; avgMs: number; maxMs: number }[];
	durationSec: number;
	eventLoopLag: EventLoopLagSummary;
};

// ---- Profiler ----

export class RenderProfiler {
	#active = false;
	#fd: number | null = null;
	#filePath = "";
	#frames: FrameMetrics[] = [];
	#lagSamplesMs: number[] = [];
	#lagSpikeCount = 0;
	#lagExpectedTs = 0;
	#lagTimer: NodeJS.Timeout | null = null;

	// Per-frame scratch state
	#frameStart = 0;
	#phaseStart = 0;
	#currentPhase = "";
	#phases: PhaseTimings = {};
	#bordersRedrawn = false;
	#queueDepth = 0;

	isActive(): boolean {
		return this.#active;
	}

	toggle(): boolean {
		if (this.#active) {
			this.#stop();
			return false;
		}
		this.#start();
		return true;
	}

	// ---- Lifecycle ----

	#start(): void {
		const dir = path.join(os.homedir(), ".oms");
		try {
			fs.mkdirSync(dir, { recursive: true });
		} catch (err) {
			logger.debug("tui/profiler.ts: best-effort failure after fs.mkdirSync(dir, { recursive: true });", { err });
		}
		this.#filePath = path.join(dir, "render-profile.jsonl");
		try {
			this.#fd = fs.openSync(this.#filePath, "w");
		} catch {
			this.#fd = null;
		}
		this.#frames = [];
		this.#lagSamplesMs = [];
		this.#lagSpikeCount = 0;
		this.#lagExpectedTs = 0;
		this.#active = true;
		this.#startLagMonitor();
	}
	#stop(): void {
		this.#active = false;
		this.#stopLagMonitor();
		this.#writeSummary();
		if (this.#fd !== null) {
			try {
				fs.closeSync(this.#fd);
			} catch (err) {
				logger.debug("tui/profiler.ts: best-effort failure after fs.closeSync(this.#fd);", { err });
			}
			this.#fd = null;
		}
		this.#frames = [];
		this.#lagSamplesMs = [];
		this.#lagSpikeCount = 0;
		this.#lagExpectedTs = 0;
	}

	// ---- Per-frame API ----

	/** Call at the very start of redraw(). */
	beginFrame(queueDepth: number): void {
		if (!this.#active) return;
		this.#frameStart = Bun.nanoseconds();
		this.#phaseStart = this.#frameStart;
		this.#currentPhase = "";
		this.#phases = {};
		this.#bordersRedrawn = false;
		this.#queueDepth = queueDepth;
	}

	/** Mark the start of a named phase (ends the previous phase). */
	startPhase(name: string): void {
		if (!this.#active) return;
		this.#endCurrentPhase();
		this.#currentPhase = name;
		this.#phaseStart = Bun.nanoseconds();
	}

	/** Mark that borders were redrawn this frame. */
	markBordersRedrawn(): void {
		if (!this.#active) return;
		this.#bordersRedrawn = true;
	}

	/** Call at end of redraw() after the terminal write. */
	endFrame(bufferLength: number): void {
		if (!this.#active) return;
		this.#endCurrentPhase();
		const totalNs = Bun.nanoseconds() - this.#frameStart;
		const metrics: FrameMetrics = {
			ts: Date.now(),
			totalMs: nsToMs(totalNs),
			phases: { ...this.#phases },
			bordersRedrawn: this.#bordersRedrawn,
			bufferLength,
			queueDepth: this.#queueDepth,
		};
		this.#frames.push(metrics);
		this.#writeLine(metrics);
	}

	// ---- Internal ----
	#startLagMonitor(): void {
		this.#lagExpectedTs = Date.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS;
		this.#lagTimer = setTimeout(() => {
			this.#sampleEventLoopLag();
		}, EVENT_LOOP_SAMPLE_INTERVAL_MS);

		const timer = this.#lagTimer as NodeJS.Timeout & { unref?: () => void };
		if (typeof timer.unref === "function") timer.unref();
	}

	#stopLagMonitor(): void {
		if (!this.#lagTimer) return;
		clearTimeout(this.#lagTimer);
		this.#lagTimer = null;
	}

	#sampleEventLoopLag(): void {
		if (!this.#active) return;
		const now = Date.now();
		const driftMs = Math.max(0, now - this.#lagExpectedTs);
		this.#lagSamplesMs.push(driftMs);
		if (driftMs > EVENT_LOOP_LAG_SPIKE_MS) {
			this.#lagSpikeCount += 1;
			const lagRecord: EventLoopLagRecord = {
				type: "event-loop-lag",
				ts: now,
				expectedTs: this.#lagExpectedTs,
				driftMs: round3(driftMs),
			};
			this.#writeLine(lagRecord);
		}

		this.#lagExpectedTs = now + EVENT_LOOP_SAMPLE_INTERVAL_MS;
		this.#lagTimer = setTimeout(() => {
			this.#sampleEventLoopLag();
		}, EVENT_LOOP_SAMPLE_INTERVAL_MS);

		const timer = this.#lagTimer as NodeJS.Timeout & { unref?: () => void };
		if (typeof timer.unref === "function") timer.unref();
	}
	#endCurrentPhase(): void {
		if (!this.#currentPhase) return;
		const elapsed = Bun.nanoseconds() - this.#phaseStart;
		this.#phases[this.#currentPhase] = nsToMs(elapsed);
		this.#currentPhase = "";
	}

	#writeLine(data: unknown): void {
		if (this.#fd === null) return;
		try {
			const line = `${JSON.stringify(data)}\n`;
			fs.writeSync(this.#fd, line);
		} catch {
			// Profiling is best-effort; drop write failures to avoid impacting the TUI.
		}
	}

	#writeSummary(): void {
		if (this.#frames.length === 0) return;

		const totals = this.#frames.map(f => f.totalMs).sort((a, b) => a - b);
		const n = totals.length;

		// Aggregate per-phase stats
		const phaseAcc: Record<string, { sum: number; max: number; count: number }> = {};
		for (const frame of this.#frames) {
			for (const [phase, ms] of Object.entries(frame.phases)) {
				let acc = phaseAcc[phase];
				if (!acc) {
					acc = { sum: 0, max: 0, count: 0 };
					phaseAcc[phase] = acc;
				}
				acc.sum += ms;
				acc.max = Math.max(acc.max, ms);
				acc.count += 1;
			}
		}

		const slowestPhases = Object.entries(phaseAcc)
			.map(([phase, acc]) => ({
				phase,
				avgMs: round3(acc.sum / acc.count),
				maxMs: round3(acc.max),
			}))
			.sort((a, b) => b.avgMs - a.avgMs)
			.slice(0, 10);

		const lagSummary = summarizeLag(this.#lagSamplesMs, this.#lagSpikeCount);
		const firstTs = this.#frames[0]!.ts;
		const lastTs = this.#frames[n - 1]!.ts;

		const summary: FrameSummary = {
			type: "summary",
			frames: n,
			totalMs: {
				avg: round3(totals.reduce((s, v) => s + v, 0) / n),
				p50: totals[Math.floor(n * 0.5)]!,
				p95: totals[Math.min(n - 1, Math.floor(n * 0.95))]!,
				max: totals[n - 1]!,
			},
			slowestPhases,
			durationSec: round3((lastTs - firstTs) / 1000),
			eventLoopLag: lagSummary,
		};

		this.#writeLine(summary);
	}
}

function summarizeLag(samples: readonly number[], spikesOverThreshold: number): EventLoopLagSummary {
	if (samples.length === 0) {
		return {
			samples: 0,
			avgMs: 0,
			p95Ms: 0,
			maxMs: 0,
			spikesOverThreshold,
		};
	}

	const sorted = [...samples].sort((a, b) => a - b);
	const count = sorted.length;
	const sum = sorted.reduce((total, value) => total + value, 0);
	return {
		samples: count,
		avgMs: round3(sum / count),
		p95Ms: round3(sorted[Math.min(count - 1, Math.floor(count * 0.95))] ?? 0),
		maxMs: round3(sorted[count - 1] ?? 0),
		spikesOverThreshold,
	};
}

function nsToMs(ns: number): number {
	return round3(ns / 1_000_000);
}

function round3(v: number): number {
	return Math.round(v * 1000) / 1000;
}
