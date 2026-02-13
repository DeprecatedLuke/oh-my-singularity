import { type AgentInfo, type AgentUsage, createEmptyAgentUsage } from "../agents/types";
import { asRecord } from "../utils";

function toFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return parsed;
}

export function extractAssistantUsageDelta(event: unknown): AgentUsage | null {
	const rec = asRecord(event);
	if (!rec || rec.type !== "message_end") return null;

	const message = asRecord(rec.message);
	if (!message || message.role !== "assistant") return null;

	const usage = asRecord(message.usage);
	if (!usage) return null;

	const input = toFiniteNumber(usage.input);
	const output = toFiniteNumber(usage.output);
	const cacheRead = toFiniteNumber(usage.cacheRead);
	const cacheWrite = toFiniteNumber(usage.cacheWrite);
	const computedTotal = input + output + cacheRead + cacheWrite;
	const totalTokens = toFiniteNumber(usage.totalTokens) || computedTotal;

	const costRec = asRecord(usage.cost);
	const costTotal = costRec
		? toFiniteNumber(costRec.total) ||
			toFiniteNumber(costRec.input) +
				toFiniteNumber(costRec.output) +
				toFiniteNumber(costRec.cacheRead) +
				toFiniteNumber(costRec.cacheWrite)
		: 0;

	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: costTotal,
	};
}

export function applyUsageDelta(agent: AgentInfo, delta: AgentUsage): void {
	const usage = agent.usage ?? createEmptyAgentUsage();
	agent.usage = usage;
	usage.input += delta.input;
	usage.output += delta.output;
	usage.cacheRead += delta.cacheRead;
	usage.cacheWrite += delta.cacheWrite;
	usage.totalTokens += delta.totalTokens;
	usage.cost += delta.cost;
}

/** Extract the cumulative input token count from a message_end assistant event. */
export function extractContextTokens(event: unknown): number | null {
	const rec = asRecord(event);
	if (!rec || rec.type !== "message_end") return null;

	const message = asRecord(rec.message);
	if (!message || message.role !== "assistant") return null;

	const usage = asRecord(message.usage);
	if (!usage) return null;

	// input tokens = context sent to the model on this turn (our best proxy for context usage)
	const input = toFiniteNumber(usage.input);
	const cacheRead = toFiniteNumber(usage.cacheRead);
	// Total context = fresh input + cached input
	const total = input + cacheRead;
	return total > 0 ? total : null;
}
