/**
 * missions.ts's `POST /:id/resume` — the volume-existence guard added after a
 * live incident (2026-09-23): `mission.volumeId` in MongoDB had drifted to a
 * volume that no longer existed on Fly. Resume deleted the mission's healthy
 * machine first, then failed to re-create it against the bad volume ID,
 * leaving the mission down even though the real data volume was untouched
 * the whole time. This guard checks the volume exists BEFORE the old,
 * working machine is destroyed.
 *
 * Fly and the machine-lifecycle layer are mocked; Mongo is the shared
 * in-memory fake, so the real route logic (guard order, Mongo writes on
 * success/failure) is exercised.
 */

import type { Server } from "node:http";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteMachine,
	getMachineState,
	isLocalExecution,
	volumeExists,
} from "../src/fly-machines.js";
import { provisionTracked } from "../src/machine-lifecycle.js";
import { createMissionsRouter } from "../src/missions.js";
import { fakeDb } from "./support/fake-db.js";

vi.mock("../src/fly-machines.js", () => ({
	isLocalExecution: vi.fn(() => false),
	getMachineState: vi.fn(),
	machineExists: vi.fn(),
	volumeExists: vi.fn(),
	deleteMachine: vi.fn(),
	destroyLocal: vi.fn(),
	provisionLocal: vi.fn(),
}));
vi.mock("../src/machine-lifecycle.js", () => ({
	provisionTracked: vi.fn(),
	destroyTracked: vi.fn(),
}));

const mockedVolumeExists = vi.mocked(volumeExists);
const mockedDeleteMachine = vi.mocked(deleteMachine);
const mockedProvisionTracked = vi.mocked(provisionTracked);
const mockedGetMachineState = vi.mocked(getMachineState);
const mockedIsLocalExecution = vi.mocked(isLocalExecution);

async function startApp(missions: Record<string, unknown>[]) {
	const { db, data } = fakeDb({ missions, machineSegments: [] });
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.userId = "u1";
		req.isAdmin = false;
		next();
	});
	app.use("/api/missions", createMissionsRouter(db as never));

	const server: Server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { baseUrl: `http://127.0.0.1:${port}/api/missions`, server, data };
}

const missionDoc = (over: Record<string, unknown> = {}) => ({
	missionId: "m1",
	userId: "u1",
	name: "Test",
	teamConfig: "inline",
	status: "suspended",
	machineId: "old-machine",
	volumeId: "vol_real",
	createdAt: new Date(),
	updatedAt: new Date(),
	...over,
});

describe("POST /:id/resume — volume-existence guard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedIsLocalExecution.mockReturnValue(false);
		mockedGetMachineState.mockResolvedValue("stopped");
	});

	it("checks the volume BEFORE deleting the old machine, and never deletes it when the volume is gone", async () => {
		mockedVolumeExists.mockResolvedValue(false);
		const { baseUrl, server, data } = await startApp([missionDoc()]);
		try {
			const res = await fetch(`${baseUrl}/m1/resume`, { method: "POST" });
			expect(res.status).toBe(500);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("does not exist on Fly");

			expect(mockedDeleteMachine).not.toHaveBeenCalled();
			expect(mockedProvisionTracked).not.toHaveBeenCalled();

			const doc = data.missions[0];
			expect(doc.status).toBe("error");
			expect(doc.errorMessage).toContain("does not exist on Fly");
			// The old (still-healthy) machine reference is left untouched.
			expect(doc.machineId).toBe("old-machine");
			expect(doc.volumeId).toBe("vol_real");
		} finally {
			server.close();
		}
	});

	it("raises a hard resume-failure anomaly on any resume failure, waking the copilot", async () => {
		mockedVolumeExists.mockResolvedValue(false);
		const { baseUrl, server, data } = await startApp([missionDoc()]);
		try {
			await fetch(`${baseUrl}/m1/resume`, { method: "POST" });

			const anomaly = data.missionAnomalies.find((a) => a.missionId === "m1");
			expect(anomaly).toMatchObject({
				category: "resume-failure",
				severity: "hard",
			});
			expect(anomaly?.message).toContain("does not exist on Fly");
			// Hard severity relays to the owning user's control-plane copilot.
			expect(data.mailbox.some((m) => m.missionId === "copilot-u1")).toBe(true);
		} finally {
			server.close();
		}
	});

	it("deletes the old machine and provisions a new one when the volume exists", async () => {
		mockedVolumeExists.mockResolvedValue(true);
		mockedDeleteMachine.mockResolvedValue(undefined);
		mockedProvisionTracked.mockResolvedValue({
			machineId: "new-machine",
			privateIp: "fdaa::1",
			volumeId: "vol_real",
		});
		const { baseUrl, server, data } = await startApp([missionDoc()]);
		try {
			const res = await fetch(`${baseUrl}/m1/resume`, { method: "POST" });
			expect(res.status).toBe(200);

			expect(mockedDeleteMachine).toHaveBeenCalledWith("old-machine");
			expect(mockedProvisionTracked).toHaveBeenCalled();

			const doc = data.missions[0];
			expect(doc.status).toBe("running");
			expect(doc.machineId).toBe("new-machine");
			expect(doc.errorMessage).toBeUndefined();
		} finally {
			server.close();
		}
	});

	it("does not check volumeExists at all for a local-execution mission", async () => {
		mockedIsLocalExecution.mockReturnValue(true);
		const { baseUrl, server, data } = await startApp([
			missionDoc({ machineId: "local-m1" }),
		]);
		try {
			const res = await fetch(`${baseUrl}/m1/resume`, { method: "POST" });
			expect(res.status).toBe(200);
			expect(mockedVolumeExists).not.toHaveBeenCalled();
			expect(data.missions[0].status).toBe("running");
		} finally {
			server.close();
		}
	});
});
