import { describe, expect, it, vi } from "vitest";
import { exitOnFatal } from "../src/exit-on-fatal.js";

describe("exitOnFatal", () => {
	it("names the process and the error, prints the stack, exits 1", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		exitOnFatal("cli:test")(new Error("boom"));
		expect(err.mock.calls[0][0]).toBe("[cli:test] fatal: boom");
		expect(String(err.mock.calls[1][0])).toContain("Error: boom");
		expect(exit).toHaveBeenCalledWith(1);
		err.mockRestore();
		exit.mockRestore();
	});

	it("handles a thrown non-Error", () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
		exitOnFatal("p")("plain string");
		expect(err.mock.calls[0][0]).toBe("[p] fatal: plain string");
		err.mockRestore();
		exit.mockRestore();
	});
});
