export function sanitizeRenderableText(value: string): string {
	return value
		.replace(/\r/g, "")
		.replace(/\t/g, "  ")
		.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

export function sanitizeChunk(value: unknown): string {
	if (typeof value !== "string") return "";
	return sanitizeRenderableText(value);
}

export function tryFormatJson(text: string): string | null {
	let candidate = text.trim();
	if (!candidate) return null;

	const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fenced && typeof fenced[1] === "string") candidate = fenced[1].trim();

	for (let depth = 0; depth < 2; depth += 1) {
		if (!candidate.startsWith("{") && !candidate.startsWith("[") && !candidate.startsWith('"')) {
			return null;
		}

		try {
			const parsed = JSON.parse(candidate);
			if (typeof parsed === "string") {
				candidate = parsed.trim();
				continue;
			}
			if (typeof parsed === "object" && parsed !== null) {
				return JSON.stringify(parsed, null, 2);
			}
			return null;
		} catch {
			return null;
		}
	}
	return null;
}

export function wrapLine(text: string, width: number): string[] {
	if (width <= 0) return [];
	const out: string[] = [];
	const logicalLines = text.split(/\r?\n/);

	for (const line of logicalLines) {
		if (line.length === 0) {
			out.push("");
			continue;
		}

		let rest = line;
		while (rest.length > width) {
			let breakAt = rest.lastIndexOf(" ", width);
			if (breakAt <= 0) breakAt = width;
			const chunk = rest.slice(0, breakAt).trimEnd();
			out.push(chunk.length > 0 ? chunk : rest.slice(0, width));
			rest = rest.slice(breakAt).trimStart();
		}
		out.push(rest);
	}

	return out;
}
