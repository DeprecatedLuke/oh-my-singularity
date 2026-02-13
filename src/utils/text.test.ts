import { describe, expect, test } from "bun:test";

import { clipText, previewValue, squashWhitespace } from "./text";

describe("squashWhitespace", () => {
	test("collapses all whitespace runs and trims edges", () => {
		expect(squashWhitespace("  alpha\n\t beta   gamma  ")).toBe("alpha beta gamma");
	});

	test("returns empty string when input is only whitespace", () => {
		expect(squashWhitespace("\n\t   ")).toBe("");
	});
});

describe("clipText", () => {
	test("clips text by max width with ellipsis", () => {
		expect(clipText("abcdef", 4)).toBe("abc…");
		expect(clipText("abcdef", 1)).toBe("…");
	});
});

describe("previewValue", () => {
	test("returns empty string for undefined", () => {
		expect(previewValue(undefined)).toBe("");
	});

	test("returns string as-is when under max", () => {
		expect(previewValue("hello", 10)).toBe("hello");
	});

	test("clips long strings with ellipsis", () => {
		expect(previewValue("abcdef", 4)).toBe("abc…");
	});

	test("stringifies objects and squashes whitespace", () => {
		expect(previewValue({ text: "line 1\nline 2" })).toBe('{"text":"line 1\\nline 2"}');
	});

	test("falls back for unstringifiable values", () => {
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(previewValue(circular)).toBe("[value]");
	});

	test("squashes whitespace before clipping", () => {
		expect(previewValue("  many\n\t spaces here  ", 12)).toBe("many spaces…");
	});
});
