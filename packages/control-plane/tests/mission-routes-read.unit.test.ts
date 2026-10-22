import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createMissionsRouter } from "../src/missions.js";
import { monitorUrl } from "../src/monitor-token.js";
import { fakeDb } from "./support/fake-db.js";

let server: Server | undefined;
afterEach(
	() =>
		new Promise<void>((r) => {
			if (!server) return r();
			server.close(() => r());
			server = undefined;
		}),
);

async function startApp(missions: Record<string, unknown>[]) {
	const { db, data } = fakeDb({ missions });
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		req.userId = "u1";
		req.isAdmin = false;
		next();
	});
	app.use("/api/missions", createMissionsRouter(db as never));
	server = await new Promise((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});
	const addr = server?.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return { base: `http://127.0.0.1:${port}/api/missions`, data };
}

const mission = {
	missionId: "m1",
	userId: "u1",
	name: "Gold",
	status: "running",
	createdAt: new Date(),
	mission: { id: "m1", name: "Gold", maxCostUsd: 25 },
	agents: [{ id: "lead" }, { id: "analyst" }],
	teamFiles: [{ path: "skills/x/SKILL.md", content: "x".repeat(10_000) }],
};

describe("mission read routes", () => {
	it("refuses a message to a recipient not on the roster (MIS3)", async () => {
		const { base, data } = await startApp([mission]);
		const send = (to: unknown) =>
			fetch(`${base}/m1/messages/send`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ to, body: "hello" }),
			});
		const bad = await send(["lead", "anlyst"]);
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toContain("anlyst");
		expect(data.mailbox ?? []).toHaveLength(0);
		expect((await send(["lead", "mission-copilot"])).status).toBe(200);
	});
});

describe("monitorUrl (MIS1)", () => {
	it("brackets IPv6 only", () => {
		expect(monitorUrl("fdaa::5", "/status")).toBe(
			"http://[fdaa::5]:4000/status",
		);
		expect(monitorUrl("127.0.0.1", "/status")).toBe(
			"http://127.0.0.1:4000/status",
		);
	});
});
