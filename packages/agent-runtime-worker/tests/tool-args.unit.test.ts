import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { checkToolArguments, MAX_REJECTION_CHARS } from "../src/tool-args.js";

const writeTool = {
	name: "WriteFile",
	parameters: Type.Object({
		path: Type.String(),
		content: Type.String(),
		append: Type.Optional(Type.Boolean()),
	}),
};

describe("checkToolArguments (LP2)", () => {
	it("rejects a missing required field, naming it", () => {
		const r = checkToolArguments(writeTool, {
			id: "c1",
			name: "WriteFile",
			arguments: { path: "a.txt" },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain('Validation failed for tool "WriteFile"');
			expect(r.message).toMatch(/content/);
		}
	});

	it("rejects a wrong type that cannot be coerced", () => {
		const r = checkToolArguments(writeTool, {
			id: "c1",
			name: "WriteFile",
			arguments: { path: ["not", "a", "string"], content: "x" },
		});
		expect(r.ok).toBe(false);
	});

	it("converts a number given for a string field (TypeBox Convert semantics)", () => {
		const r = checkToolArguments(writeTool, {
			id: "c1",
			name: "WriteFile",
			arguments: { path: 7, content: "x" },
		});
		expect(r).toEqual({ ok: true, args: { path: "7", content: "x" } });
	});

	it("coerces unambiguous primitives and hands the tool the coerced copy", () => {
		const numTool = {
			name: "Sleep",
			parameters: Type.Object({
				seconds: Type.Number(),
				verbose: Type.Boolean(),
			}),
		};
		const input = { seconds: "5", verbose: "true" };
		const r = checkToolArguments(numTool, {
			id: "c1",
			name: "Sleep",
			arguments: input,
		});
		expect(r).toEqual({ ok: true, args: { seconds: 5, verbose: true } });
		// The caller's object is untouched — the tool gets a copy.
		expect(input).toEqual({ seconds: "5", verbose: "true" });
	});

	it("accepts either shape of a union field (a single recipient or a list)", () => {
		const post = {
			name: "PostMessage",
			parameters: Type.Object({
				to: Type.Union([Type.Array(Type.String()), Type.String()]),
				body: Type.String(),
			}),
		};
		expect(
			checkToolArguments(post, {
				id: "c",
				name: "PostMessage",
				arguments: { to: "lead", body: "hi" },
			}).ok,
		).toBe(true);
		expect(
			checkToolArguments(post, {
				id: "c",
				name: "PostMessage",
				arguments: { to: ["lead", "user"], body: "hi" },
			}).ok,
		).toBe(true);
		expect(
			checkToolArguments(post, {
				id: "c",
				name: "PostMessage",
				arguments: { to: { name: "lead" }, body: "hi" },
			}).ok,
		).toBe(false);
	});

	it("treats absent arguments as an empty object", () => {
		const r = checkToolArguments(
			{ name: "Noop", parameters: Type.Object({}) },
			{ id: "c", name: "Noop", arguments: undefined },
		);
		expect(r).toEqual({ ok: true, args: {} });
	});

	it("bounds the rejection message even when the echoed arguments are huge", () => {
		const r = checkToolArguments(writeTool, {
			id: "c1",
			name: "WriteFile",
			arguments: { path: { nested: true }, content: "x".repeat(200_000) },
		});
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message.length).toBeLessThan(MAX_REJECTION_CHARS + 100);
			expect(r.message).toContain("truncated");
		}
	});
});
