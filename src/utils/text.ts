import { clipText } from "../tui/colors";

export { clipText };

export function squashWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function previewValue(value: unknown, max = 120): string {
	if (value === undefined) return "";
	let raw: string;
	if (typeof value === "string") {
		raw = value;
	} else {
		try {
			raw = JSON.stringify(value);
		} catch {
			raw = "[value]";
		}
	}
	return clipText(squashWhitespace(raw), max);
}
