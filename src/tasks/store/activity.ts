import type { TaskActivityEvent } from "../types";
import { DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_EVENTS, type StoreSnapshot } from "./types";
import { buildActivityEventId, normalizeString, nowIso } from "./utilities";

export function pushActivity(
	state: StoreSnapshot,
	event: Omit<TaskActivityEvent, "id" | "created_at" | "updated_at">,
	actor: string,
): TaskActivityEvent {
	const createdAt = nowIso();
	const normalized: TaskActivityEvent = {
		...event,
		id: buildActivityEventId(),
		created_at: createdAt,
		updated_at: createdAt,
		type: normalizeString(event.type) ?? "event",
		actor: normalizeString(event.actor) ?? actor,
	};
	state.activity.push(normalized);
	if (state.activity.length > MAX_ACTIVITY_EVENTS) {
		state.activity.splice(0, state.activity.length - MAX_ACTIVITY_EVENTS);
	}
	return normalized;
}

export function getActivity(state: StoreSnapshot, requestedLimit?: number): TaskActivityEvent[] {
	const limit =
		typeof requestedLimit === "number" && Number.isFinite(requestedLimit)
			? Math.max(0, Math.trunc(requestedLimit))
			: DEFAULT_ACTIVITY_LIMIT;
	if (limit === 0) return [...state.activity].reverse();
	const slice = state.activity.slice(Math.max(0, state.activity.length - limit));
	return [...slice].reverse();
}
