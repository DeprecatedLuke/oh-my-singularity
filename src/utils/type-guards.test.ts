import { describe, expect, test } from "bun:test";

import { asRecord } from "./type-guards";

describe("asRecord", () => {
	test("returns null for nullish values", () => {
		expect(asRecord(null)).toBeNull();
		expect(asRecord(undefined)).toBeNull();
	});

	test("returns null for arrays and primitives", () => {
		expect(asRecord([])).toBeNull();
		expect(asRecord("x")).toBeNull();
		expect(asRecord(1)).toBeNull();
		expect(asRecord(false)).toBeNull();
	});

	test("returns object as record", () => {
		const obj = { a: 1, b: "two" };
		expect(asRecord(obj)).toBe(obj);
	});
});
