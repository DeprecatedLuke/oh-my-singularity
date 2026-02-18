export const MS_PER_SECOND = 1_000;
export const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;

export const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

const MILLISECONDS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MILLISECONDS_PER_HOUR = MILLISECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const MILLISECONDS_PER_DAY = MILLISECONDS_PER_HOUR * HOURS_PER_DAY;

export const TIMEOUT_MIN_MS = MS_PER_SECOND;
export const TIMEOUT_DEFAULT_POLL_MS = 5_000;
export const TIMEOUT_STEERING_INTERVAL_MS = 15 * MILLISECONDS_PER_MINUTE;
export const TIMEOUT_STALE_AGENT_TTL_MS = 15 * MILLISECONDS_PER_MINUTE;
export const TIMEOUT_AGENT_WAIT_MS = MILLISECONDS_PER_DAY;
export const TIMEOUT_QUIET_WINDOW_BASE_MS = 1_500;
export const TIMEOUT_QUIET_WINDOW_POLL_OFFSET_MS = TIMEOUT_MIN_MS;
export const TIMEOUT_REGISTRY_DEFAULT_INTERVAL_MS = 15_000;

export const TIMEOUT_AGENT_STOP_GRACE_MS = 2_000;

export const DEFAULT_MAX_WORKERS = 5;
export const DEFAULT_LAYOUT_TASKS_HEIGHT_RATIO = 0.25;
export const DEFAULT_LAYOUT_AGENTS_WIDTH_RATIO = 0.45;
export const DEFAULT_LAYOUT_SYSTEM_HEIGHT_RATIO = 0.3;

export const INTERVAL_WAIT_SLEEP_MS = 200;
export const INTERVAL_POLLER_MIN_MS = 100;

export const DELAY_DEFERRED_FLUSH_MS = 250;
export const DELAY_PIPE_EMPTY_WORK_GRACE_MS = 750;
export const DELAY_PIPE_FORCE_EXIT_GRACE_MS = 3_000;

export const LIMIT_ACTIVITY_DEFAULT = 100;
export const LIMIT_TASK_LIST_DEFAULT = 50;
export const LIMIT_ACTIVITY_MAX_EVENTS = 5_000;
export const LIMIT_AGENT_LOG_MESSAGES = 2_000;
export const LIMIT_AGENT_ISSUES = 400;
export const LIMIT_AGENT_LOGS = 400;
export const LIMIT_AGENT_EVENT_BUFFER = 10_000;
export const LIMIT_MESSAGE_HISTORY_DEFAULT = 40;
export const LIMIT_MESSAGE_HISTORY_MAX = 200;
export const LIMIT_POLLER_SEEN_ACTIVITY = 2_000;
export const LIMIT_POLLER_ACTIVITY_DEFAULT = 200;
export const LIMIT_TASK_TREE_RENDER_DEPTH = 10_000;

export const UI_FLASH_DURATION_MS = 100;
export const UI_FLASH_DEBOUNCE_MS = 80;
export const UI_SCROLL_STEP_LINES = 3;
export const UI_RESULT_MAX_LINES = 8;
export const UI_MARKDOWN_CACHE_LIMIT = 128;
export const UI_AGENT_SUMMARY_MAX_CHARS = 180;

export const PATH_MAX_SOCK_PATH_LENGTH = 100;

export const AGENT_EXTENSION_FILENAMES = {
	worker: "tasks-worker.ts",
	designerWorker: "tasks-designer-worker.ts",
	finisher: "tasks-finisher.ts",
	steering: "tasks-steering.ts",
	issuer: "tasks-issuer.ts",
	broadcast: "broadcast-to-workers.ts",
	complain: "complain.ts",
	waitForAgent: "wait-for-agent.ts",
	readMessageHistory: "read-message-history.ts",
	readTaskMessageHistory: "read-task-message-history.ts",
	steerAgent: "steer-agent.ts",
	steeringReplaceAgent: "steering-replace-agent.ts",
	tasksBashGuard: "tasks-bash-guard.ts",
	ompCrashLogger: "omp-crash-logger.ts",
	startTasks: "start-tasks.ts",
	tasksCommand: "tasks-command.ts",
	tasksSingularity: "tasks-singularity.ts",
	singularityToolGuard: "singularity-tool-guard.ts",
	interruptAgent: "interrupt-agent.ts",
	replaceAgent: "replace-agent.ts",
	deleteTaskIssue: "delete-task-issue.ts",
} as const;

export const SINGULARITY_EXTENSION_FILENAMES = [
	AGENT_EXTENSION_FILENAMES.startTasks,
	AGENT_EXTENSION_FILENAMES.tasksCommand,
	AGENT_EXTENSION_FILENAMES.tasksSingularity,
	AGENT_EXTENSION_FILENAMES.broadcast,
	AGENT_EXTENSION_FILENAMES.replaceAgent,
	AGENT_EXTENSION_FILENAMES.deleteTaskIssue,
	AGENT_EXTENSION_FILENAMES.singularityToolGuard,
	AGENT_EXTENSION_FILENAMES.tasksBashGuard,
] as const;
