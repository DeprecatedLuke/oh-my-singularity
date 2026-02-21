import type { AgentType, SpawnableAgent } from "../config/constants";
export type { AgentType, SpawnableAgent };

export type AgentStatus =
	| "spawning"
	| "running"
	| "working"
	| "stuck"
	| "done"
	| "failed"
	| "aborted"
	| "stopped"
	| "dead"
	| (string & {});

export interface AgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export function createEmptyAgentUsage(): AgentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
	};
}
export type AgentEvent =
	| {
			type: "log";
			ts: number;
			level?: "debug" | "info" | "warn" | "error" | (string & {});
			message: string;
			data?: unknown;
	  }
	| {
			type: "status";
			ts: number;
			status: AgentStatus;
			note?: string;
	  }
	| {
			type: "metric";
			ts: number;
			name: string;
			value: number;
			unit?: string;
	  }
	| {
			type: string;
			ts?: number;
			[key: string]: unknown;
	  };

export interface AgentInfo {
	/** Local registry id (stable within this process). */
	id: string;

	agentType: AgentType;
	taskId: string | null;
	/** Replica working directory used by editable agents (worker/finisher). */
	replicaDir?: string;

	/** tasks issue id for the agent issue backing this runtime agent. */
	tasksAgentId: string;

	status: AgentStatus;

	usage: AgentUsage;

	/** Rolling buffer of recent events for display. */
	events: AgentEvent[];

	/** Epoch millis. */
	spawnedAt: number;

	/** Epoch millis; updated on events / heartbeats. */
	lastActivity: number;
	/** Model identifier used for this agent (from config). */
	model?: string;
	/** Thinking level configured for this agent. */
	thinking?: string;
	/** OMP session id for this agent process/session. */
	sessionId?: string;
	/** Model context window size (tokens). 0 or undefined = unknown. */
	contextWindow?: number;
	/** Estimated current context token usage (from last assistant message input). */
	contextTokens?: number;
	/** Number of successful compaction events observed. */
	compactionCount?: number;

	/** RPC client wrapper for agent communication. */
	rpc?: unknown;
}
