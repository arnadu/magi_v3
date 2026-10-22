/**
 * GET/PATCH /api/copilot/limits — how the user manages the copilot's cap from
 * the cockpit (CST-3): there is always a cap, "reset" returns to the default
 * instead of removing it, and only a platform admin may go above the platform
 * ceiling. The real routes behind a local server, on an in-memory db.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, {
	type NextFunction,
	type Request,
	type Response,
	Router,
} from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asyncRoutes } from "../src/async-handler.js";
import { DEFAULT_COPILOT_SPEND_CAP_USD } from "../src/copilot-spend.js";
import { registerCopilotVisibilityRoutes } from "../src/copilot-visibility-routes.js";
import { fakeDb } from "./support/fake-db.js";

const { db, data } = fakeDb({ users: [{ uid: "u1" }], missionStats: [] });
let server: Server;
let base: string;
let admin = false;

beforeAll(async () => {
	const app = express();
	app.use(express.json());
	app.use((req: Request, _res: Response, next: NextFunction) => {
		req.userId = "u1";
		req.isAdmin = admin;
		next();
	});
	const router = Router();
	registerCopilotVisibilityRoutes(router, asyncRoutes(router), db);
	app.use("/api/copilot", router);
	await new Promise<void>((resolve) => {
		server = app.listen(0, "127.0.0.1", resolve);
	});
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/copilot/limits`;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
});

const patch = (capUsd: number | null) =>
	fetch(base, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ capUsd }),
	});

describe("/api/copilot/limits", () => {
	it("reports the default cap when the user set none, with the ceiling and turn limit", async () => {
		const body = await (await fetch(base)).json();
		expect(body).toMatchObject({
			capUsd: DEFAULT_COPILOT_SPEND_CAP_USD,
			isDefault: true,
			defaultCapUsd: DEFAULT_COPILOT_SPEND_CAP_USD,
			ceilingUsd: 100,
			spentUsd: 0,
			maxTurnMinutes: 20,
		});
	});

	it("sets a cap, and null resets it to the default rather than removing it", async () => {
		expect((await patch(40)).status).toBe(200);
		expect(await (await fetch(base)).json()).toMatchObject({
			capUsd: 40,
			isDefault: false,
		});
		expect((await patch(null)).status).toBe(200);
		expect(await (await fetch(base)).json()).toMatchObject({
			capUsd: DEFAULT_COPILOT_SPEND_CAP_USD,
			isDefault: true,
		});
		expect(data.users[0].copilotSpendCapUsd).toBeUndefined();
	});

	it("refuses a cap above the platform ceiling for a non-admin, and allows it for an admin", async () => {
		const refused = await patch(500);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toMatch(
			/platform ceiling/,
		);
		admin = true;
		try {
			expect((await patch(500)).status).toBe(200);
			expect(await (await fetch(base)).json()).toMatchObject({
				capUsd: 500,
				ceilingUsd: null,
			});
		} finally {
			admin = false;
		}
	});

	it("rejects a non-positive or non-numeric cap", async () => {
		expect((await patch(0)).status).toBe(400);
		const bad = await fetch(base, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ capUsd: "lots" }),
		});
		expect(bad.status).toBe(400);
	});
});
