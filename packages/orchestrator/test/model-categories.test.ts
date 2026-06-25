import { describe, expect, test } from "bun:test";
import { isModelCategory, MODEL_CATEGORIES, resolveModelCategory } from "../src/model-categories.js";

describe("model categories", () => {
	test("recognizes the three tier names and nothing else", () => {
		expect(MODEL_CATEGORIES).toEqual(["fast", "standard", "capable"]);
		expect(isModelCategory("fast")).toBe(true);
		expect(isModelCategory("standard")).toBe(true);
		expect(isModelCategory("capable")).toBe(true);
		expect(isModelCategory("opus")).toBe(false);
		expect(isModelCategory("claude-sonnet-4-5")).toBe(false);
	});

	test("resolves a configured tier to its concrete model id", () => {
		const categories = { fast: "claude-haiku-4.5", capable: "claude-opus-4.8" };
		expect(resolveModelCategory("fast", categories)).toBe("claude-haiku-4.5");
		expect(resolveModelCategory("capable", categories)).toBe("claude-opus-4.8");
	});

	test("an unconfigured tier resolves to undefined (a no-op for the caller)", () => {
		expect(resolveModelCategory("standard", { fast: "claude-haiku-4.5" })).toBeUndefined();
		expect(resolveModelCategory("capable", undefined)).toBeUndefined();
	});
});
