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
	it("sec.input-validated: rejects a missing required field, naming it", () => {
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

	it("turns a single id or a JSON-encoded list into the list a list field declares", () => {
		const post = {
			name: "PostMessage",
			parameters: Type.Object({
				to: Type.Array(Type.String()),
				meta: Type.Optional(Type.Object({ tag: Type.String() })),
				body: Type.String(),
			}),
		};
		const call = (args: Record<string, unknown>) =>
			checkToolArguments(post, {
				id: "c",
				name: "PostMessage",
				arguments: args,
			});
		expect(call({ to: "lead", body: "hi" })).toMatchObject({
			args: { to: ["lead"] },
		});
		expect(call({ to: '["lead", "user"]', body: "hi" })).toMatchObject({
			args: { to: ["lead", "user"] },
		});
		expect(
			call({ to: ["lead"], meta: '{"tag":"x"}', body: "hi" }),
		).toMatchObject({
			args: { meta: { tag: "x" } },
		});
		// Not JSON, or JSON of the wrong kind: left alone, and judged as sent.
		expect(call({ to: "[lead", body: "hi" })).toMatchObject({
			args: { to: ["[lead"] },
		});
		expect(call({ to: ["lead"], meta: "[1]", body: "hi" }).ok).toBe(false);
		expect(call({ to: { name: "lead" }, body: "hi" }).ok).toBe(false);
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
