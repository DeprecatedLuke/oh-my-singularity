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

export type ToolTheme = {
	fg: (scope: string, text: string) => string;
	bold?: (text: string) => string;
	styledSymbol?: (name: string, color: string) => string;
	sep?: {
		dot: string;
		slash?: string;
		pipe?: string;
		powerline?: string;
	};
	spinnerFrames?: string[];
	boxSharp?: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
		cross: string;
		teeDown: string;
		teeUp: string;
		teeRight: string;
		teeLeft: string;
	};
	format?: {
		bullet?: string;
		dash?: string;
		bracketLeft?: string;
		bracketRight?: string;
	};
};

export type ToolRenderComponent = {
	render: (width: number) => string[];
	invalidate?: () => void;
};

export type ToolRenderResultOptions = {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
};

export type ToolRenderCallOptions = {
	spinnerFrame?: number;
	isPartial?: boolean;
	result?: ToolResultWithError;
};

export type ToolResultWithError = ToolResult & {
	isError?: boolean;
};

export type ToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (toolCallId: string, params: ToolParams) => Promise<ToolResult>;
	mergeCallAndResult?: boolean;
	renderCall?: (args: ToolParams, theme: ToolTheme, options?: ToolRenderCallOptions) => ToolRenderComponent;
	renderResult?: (
		result: ToolResultWithError,
		options: ToolRenderResultOptions,
		theme: ToolTheme,
		args?: ToolParams,
	) => ToolRenderComponent;
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
