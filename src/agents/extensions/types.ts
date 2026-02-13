export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as UnknownRecord;
}

export type ToolParams = UnknownRecord | undefined;

export type ToolContent = {
	type: string;
	text: string;
};

export type ToolResult = {
	content: ToolContent[];
	details?: unknown;
};

export type ToolCallBlock = {
	block: boolean;
	reason: string;
};

export type ToolCallEvent = {
	toolName?: unknown;
	input?: unknown;
	args?: unknown;
	[key: string]: unknown;
};

export type ToolCallHandler = (
	event: ToolCallEvent | undefined,
) => Promise<ToolCallBlock | undefined> | ToolCallBlock | undefined;

export type TypeBoxOptions = Record<string, unknown>;

export type TypeBuilder = {
	Object: (shape: Record<string, unknown>, options?: TypeBoxOptions) => unknown;
	String: (options?: TypeBoxOptions) => unknown;
	Optional: <T>(value: T) => T;
	Union: (schemas: unknown[], options?: TypeBoxOptions) => unknown;
	Literal: (value: string | number | boolean, options?: TypeBoxOptions) => unknown;
	Array: (itemSchema: unknown, options?: TypeBoxOptions) => unknown;
	Number: (options?: TypeBoxOptions) => unknown;
	Boolean: (options?: TypeBoxOptions) => unknown;
};

export type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: ToolParams) => Promise<ToolResult>;
};

export type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type ExtensionAPI = {
	typebox: {
		Type: TypeBuilder;
	};
	registerTool: (tool: ToolDefinition) => void;
	registerCommand?: (
		name: string,
		options: { description?: string; handler: (context: unknown) => Promise<void> },
	) => void;
	on: (event: string, handler: ToolCallHandler) => void;
	exec?: (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResult>;
};
