/**
 * Copilot runtime — daemon lifecycle unit tests (ADR-0032 Decision 1).
 *
 * No MongoDB, no daemon: startCopilotDaemon and the per-user model lookup
 * are mocked, so this only exercises the runtime's own bookkeeping.
 */

import type { Db } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotDaemonHandle } from "../src/copilot-daemon.js";
import { startCopilotDaemon } from "../src/copilot-daemon.js";
import { createCopilotRuntime } from "../src/copilot-runtime.js";
import type { PendingActionsStore } from "../src/copilot-tools.js";
import { getCopilotModel } from "../src/users.js";

vi.mock("../src/copilot-daemon.js", () => ({ startCopilotDaemon: vi.fn() }));
vi.mock("../src/users.js", () => ({ getCopilotModel: vi.fn() }));

const startDaemon = vi.mocked(startCopilotDaemon);
const modelFor = vi.mocked(getCopilotModel);

function fakeHandle(): CopilotDaemonHandle {
	return {
		stop: vi.fn(),
		ready: Promise.resolve(),
		isBusy: () => false,
	};
}

function makeRuntime() {
	return createCopilotRuntime(
		{} as Db,
		"/repo",
		{} as unknown as PendingActionsStore,
	);
}

describe("createCopilotRuntime", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		startDaemon.mockImplementation(() => fakeHandle());
		modelFor.mockResolvedValue(undefined);
	});

	it("starts exactly one daemon when ensureCopilotRunning is called concurrently for the same user", async () => {
		let releaseModelLookup!: (v: string | undefined) => void;
		modelFor.mockReturnValue(
			new Promise((resolve) => {
				releaseModelLookup = resolve;
			}),
		);
		const runtime = makeRuntime();

		const calls = Promise.all([
			runtime.ensureCopilotRunning("u1"),
			runtime.ensureCopilotRunning("u1"),
			runtime.ensureCopilotRunning("u1"),
		]);
		releaseModelLookup(undefined);
		await calls;

		expect(startDaemon).toHaveBeenCalledTimes(1);
		expect(modelFor).toHaveBeenCalledTimes(1);
	});

	it("does not start another daemon once one is running", async () => {
		const runtime = makeRuntime();
		await runtime.ensureCopilotRunning("u1");
		await runtime.ensureCopilotRunning("u1");
		expect(startDaemon).toHaveBeenCalledTimes(1);
		expect(runtime.getDaemon("u1")).toBeDefined();
	});

	it("keeps daemons separate per user and passes the copilot-{userId} mailbox id", async () => {
		const runtime = makeRuntime();
		await runtime.ensureCopilotRunning("u1");
		await runtime.ensureCopilotRunning("u2");
		expect(startDaemon).toHaveBeenCalledTimes(2);
		const missionIds = startDaemon.mock.calls.map((c) => c[5]);
		expect(missionIds).toEqual(["copilot-u1", "copilot-u2"]);
		expect(runtime.getDaemon("u3")).toBeUndefined();
	});

	it("uses the user's own model when set, the default otherwise", async () => {
		const runtime = makeRuntime();
		modelFor.mockResolvedValueOnce("custom/model");
		await runtime.ensureCopilotRunning("u1");
		await runtime.ensureCopilotRunning("u2");
		expect(startDaemon.mock.calls[0][2]).toBe("custom/model");
		expect(startDaemon.mock.calls[1][2]).toBe(runtime.defaultModelId);
	});

	it("stopDaemon stops the handle and lets the next call start a fresh daemon", async () => {
		const runtime = makeRuntime();
		await runtime.ensureCopilotRunning("u1");
		const first = runtime.getDaemon("u1");
		runtime.stopDaemon("u1");
		expect(first?.stop).toHaveBeenCalledTimes(1);
		expect(runtime.getDaemon("u1")).toBeUndefined();

		await runtime.ensureCopilotRunning("u1");
		expect(startDaemon).toHaveBeenCalledTimes(2);
	});

	it("stopDaemon for a user with no daemon is a no-op", () => {
		const runtime = makeRuntime();
		expect(() => runtime.stopDaemon("nobody")).not.toThrow();
	});

	it("propagates a start failure and allows a later retry", async () => {
		const runtime = makeRuntime();
		modelFor.mockRejectedValueOnce(new Error("mongo down"));
		await expect(runtime.ensureCopilotRunning("u1")).rejects.toThrow(
			"mongo down",
		);
		expect(runtime.getDaemon("u1")).toBeUndefined();

		await runtime.ensureCopilotRunning("u1");
		expect(startDaemon).toHaveBeenCalledTimes(1);
		expect(runtime.getDaemon("u1")).toBeDefined();
	});
});
