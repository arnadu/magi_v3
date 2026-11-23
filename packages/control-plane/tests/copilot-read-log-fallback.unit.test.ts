/** ReadMissionLog: the daemon first, Fly's log buffer when the daemon does not answer. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReadTools } from "../src/copilot-read-tools.js";
import { monitorFetch } from "../src/copilot-tool-deps.js";
import { fetchMachineLog } from "../src/fly-machine-diagnostics.js";
import { fakeDb } from "./support/fake-db.js";

vi.mock("../src/copilot-tool-deps.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/copilot-tool-deps.js")>()),
	monitorFetch: vi.fn(),
}));
vi.mock("../src/fly-machine-diagnostics.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/fly-machine-diagnostics.js")
	>()),
	fetchMachineLog: vi.fn(),
}));

const mission = {
	missionId: "news",
	userId: "u1",
	status: "running",
	machineId: "82ddd01b346ed8",
	privateIp: "fdaa::2",
};

function readLog(userId = "u1") {
	const { db } = fakeDb({ missions: [mission] });
	const tool = createReadTools({
		db,
		userId,
		pushEvent: () => {},
		pending: {} as never,
	}).readMissionLog;
	return tool.execute("t1", { missionId: "news", lines: 2 });
}

const text = (r: { content: Array<{ type: string; text?: string }> }) =>
	r.content.map((c) => c.text ?? "").join("");

describe("ReadMissionLog", () => {
	beforeEach(() => {
		vi.mocked(monitorFetch).mockReset();
		vi.mocked(fetchMachineLog).mockReset();
	});

	it("reads the daemon's log when the daemon answers, without asking Fly", async () => {
		vi.mocked(monitorFetch).mockResolvedValue(
			"[daemon] Entering orchestration loop",
		);
		const r = await readLog();
		expect(text(r)).toBe("[daemon] Entering orchestration loop");
		expect(fetchMachineLog).not.toHaveBeenCalled();
	});

	it("falls back to Fly's log buffer when the daemon does not answer, and says so", async () => {
		vi.mocked(monitorFetch).mockRejectedValue(new Error("fetch failed"));
		vi.mocked(fetchMachineLog).mockResolvedValue([
			{
				timestamp: "03:36:39",
				message: "[daemon] Mission: ai-news-digest (9 agents)",
			},
			{
				timestamp: "03:36:40",
				message:
					"[daemon] Already running as PID 618 (mission: ai-news-digest).",
			},
			{
				timestamp: "03:36:50",
				message: "machine has reached its max restart count of 3",
			},
		]);
		const r = await readLog();
		expect(r.isError).toBeFalsy();
		expect(fetchMachineLog).toHaveBeenCalledWith("82ddd01b346ed8");
		expect(text(r)).toContain("The daemon did not answer: fetch failed");
		expect(text(r)).toContain("Already running as PID 618");
		expect(text(r)).not.toContain("9 agents"); // the last `lines` lines only
	});

	it("reports both failures when Fly cannot be read either", async () => {
		vi.mocked(monitorFetch).mockRejectedValue(new Error("fetch failed"));
		vi.mocked(fetchMachineLog).mockRejectedValue(
			new Error("Fly refused the log read: 401"),
		);
		const r = await readLog();
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("fetch failed");
		expect(text(r)).toContain("401");
	});

	it("never reads another user's mission, from the daemon or from Fly", async () => {
		const r = await readLog("someone-else");
		expect(r.isError).toBe(true);
		expect(monitorFetch).not.toHaveBeenCalled();
		expect(fetchMachineLog).not.toHaveBeenCalled();
	});
});
