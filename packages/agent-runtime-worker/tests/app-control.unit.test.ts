import type { ServerResponse } from "node:http";
import type { MissionAppDoc } from "@magi/agent-config";
import { describe, expect, it, vi } from "vitest";
import { controlApp } from "../src/app-control.js";
import { createAppRoutes } from "../src/monitor-routes/apps.js";

function deps() {
	const ok = vi.fn(async () => ({ ok: true as const, message: "done" }));
	return {
		supervisor: { start: ok, stop: ok, remove: ok },
		store: {
			get: async (n: string) =>
				n === "dash"
					? ({ name: "dash", owner: "analyst" } as MissionAppDoc)
					: null,
		},
		actsOnAny: new Set(["mission-copilot"]),
		notify: vi.fn(async () => {}),
	};
}

describe("controlApp (app.control, one home for every caller)", () => {
	it("lets the owner act without telling anyone", async () => {
		const d = deps();
		expect(
			await controlApp(d, "dash", "stop", { kind: "agent", id: "analyst" }),
		).toMatchObject({ ok: true });
		expect(d.notify).not.toHaveBeenCalled();
	});

	it("refuses another agent, and tells the owner when the operator or the copilot stops it", async () => {
		const d = deps();
		expect(
			await controlApp(d, "dash", "stop", { kind: "agent", id: "writer" }),
		).toEqual({
			ok: false,
			message: "app dash belongs to analyst",
		});
		await controlApp(d, "dash", "stop", { kind: "operator" });
		await controlApp(d, "dash", "remove", {
			kind: "agent",
			id: "mission-copilot",
		});
		expect(d.notify.mock.calls).toEqual([
			["analyst", "App dash stopped", "the operator stopped your app dash."],
			["analyst", "App dash removed", "mission-copilot removed your app dash."],
		]);
	});

	it("says so for an unknown app", async () => {
		expect(
			await controlApp(deps(), "nope", "start", { kind: "operator" }),
		).toEqual({
			ok: false,
			message: "no app named nope",
		});
	});
});

describe("the cockpit's app routes on the monitor server", () => {
	const res = () => {
		const r = { status: 0, body: "" };
		return {
			r,
			res: {
				writeHead(s: number) {
					r.status = s;
					return this;
				},
				end(b: string) {
					r.body = b;
				},
			} as unknown as ServerResponse,
		};
	};

	it("lists nothing and refuses control before apps have started", async () => {
		const [list, control] = createAppRoutes(() => undefined);
		const a = res();
		await list.handler({ res: a.res } as never);
		expect(JSON.parse(a.r.body)).toEqual([]);
		const b = res();
		await control.handler({ res: b.res } as never, "dash", "stop");
		expect(b.r.status).toBe(503);
	});

	it("controls an app as the operator, answering 409 on a refusal", async () => {
		const control = vi.fn(async () => ({
			ok: false,
			message: "at most 3 apps run at once",
		}));
		const [, route] = createAppRoutes(() => ({
			hop: {} as never,
			list: async () => [],
			control,
		}));
		expect("/apps/dash/start".match(route.path as RegExp)).not.toBeNull();
		expect("/apps/Dash/start".match(route.path as RegExp)).toBeNull();
		const a = res();
		await route.handler({ res: a.res } as never, "dash", "start");
		expect(control).toHaveBeenCalledWith("dash", "start");
		expect(a.r.status).toBe(409);
	});
});
