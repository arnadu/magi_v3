/**
 * Mission-copilot resource-upgrade tools (ADR-0031). No network: the control
 * plane is a fake fetch.
 */

import { describe, expect, it, vi } from "vitest";
import { createResourceUpgradeTools } from "../src/resource-upgrade-tool.js";

const URL = "https://control.example";

function setup(
	reply: { status?: number; body?: string } | Error = {},
	over = {},
) {
	const fetchFn = vi.fn(async () => {
		if (reply instanceof Error) throw reply;
		return new Response(reply.body ?? '{"ok":true}', {
			status: reply.status ?? 200,
		});
	});
	const tools = createResourceUpgradeTools({
		missionId: "m1",
		controlPlaneUrl: URL,
		monitorToken: "tok",
		fetchFn: fetchFn as unknown as typeof fetch,
		...over,
	});
	const byName = (n: string) => {
		const t = tools.find((x) => x.name === n);
		if (!t) throw new Error(`no tool ${n}`);
		return t;
	};
	return {
		fetchFn,
		tools,
		request: byName("RequestResourceUpgrade"),
		end: byName("EndResourceUpgrade"),
	};
}

const args = {
	cpuKind: "performance",
	cpus: 2,
	memoryMb: 8192,
	durationMinutes: 30,
	reason: "10 GB transform",
};

describe("tool definitions", () => {
	it("exposes exactly the request and end tools", () => {
		expect(setup().tools.map((t) => t.name)).toEqual([
			"RequestResourceUpgrade",
			"EndResourceUpgrade",
		]);
	});

	it("never lets the model name the mission", () => {
		for (const t of setup().tools) {
			const props = (t.parameters as { properties?: Record<string, unknown> })
				.properties;
			expect(Object.keys(props ?? {})).not.toContain("missionId");
		}
	});

	it("requires shape, duration and reason; requester is optional; duration is bounded 1-60", () => {
		const schema = setup().request.parameters as {
			required?: string[];
			properties: Record<string, { minimum?: number; maximum?: number }>;
		};
		expect([...(schema.required ?? [])].sort()).toEqual(
			["cpuKind", "cpus", "durationMinutes", "memoryMb", "reason"].sort(),
		);
		expect(schema.properties.durationMinutes).toMatchObject({
			minimum: 1,
			maximum: 60,
		});
	});

	it("warns that a new upgrade restarts everything and that the result may not be seen", () => {
		const d = setup().request.description;
		expect(d).toMatch(/REPLACES the mission's machine/);
		expect(d).toMatch(/no default/);
		expect(d).toMatch(/will normally not see the result/);
		expect(d).toMatch(/request-resources skill/);
	});
});

describe("RequestResourceUpgrade", () => {
	it("posts the shape with the closure's mission id and the mission token", async () => {
		const { fetchFn, request } = setup();
		const r = await request.execute("t1", {
			...args,
			requestedByAgentId: "analyst",
		});

		expect(r.isError).toBeFalsy();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const [url, init] = fetchFn.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(`${URL}/api/mission-copilot/resources/upgrade`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>)["x-monitor-token"]).toBe(
			"tok",
		);
		expect(JSON.parse(init.body as string)).toEqual({
			missionId: "m1",
			...args,
			requestedByAgentId: "analyst",
		});
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("omits requestedByAgentId when nobody asked", async () => {
		const { fetchFn, request } = setup();
		await request.execute("t1", args);
		const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(Object.keys(JSON.parse(init.body as string))).not.toContain(
			"requestedByAgentId",
		);
	});

	it("cannot be made to target another mission through its arguments", async () => {
		const { fetchFn, request } = setup();
		await request.execute("t1", { ...args, missionId: "other" });
		const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string).missionId).toBe("m1");
	});

	it("returns the control plane's success message", async () => {
		const { request } = setup({ body: '{"ok":true,"action":"renewed"}' });
		const r = await request.execute("t1", args);
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("renewed");
	});

	it.each([
		[
			400,
			'{"error":"Invalid upgrade request: cpus 6 exceeds the maximum of 4"}',
			/HTTP 400.*exceeds the maximum of 4/,
		],
		[
			403,
			'{"error":"The cumulative upgraded-runtime cap of 24 h is reached"}',
			/HTTP 403.*cap of 24 h/,
		],
		[429, '{"error":"resized less than 5 minutes ago"}', /HTTP 429.*5 minutes/],
		[
			409,
			'{"error":"Another resize is already in progress"}',
			/HTTP 409.*already in progress/,
		],
		[500, "plain text failure", /HTTP 500.*plain text failure/],
	])("reports a %s rejection as an error with the control plane's reason", async (status, body, message) => {
		const { request } = setup({ status, body });
		const r = await request.execute("t1", args);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(message);
	});

	it("explains a 404 from a control plane that predates the feature", async () => {
		const { request } = setup({ status: 404, body: "Cannot POST" });
		const r = await request.execute("t1", args);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(
			/does not support machine upgrades yet.*Nothing changed/,
		);
	});

	it("turns a network failure into an error that points at the mission message", async () => {
		const { request } = setup(new Error("socket hang up"));
		const r = await request.execute("t1", args);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(
			/socket hang up.*message in this mission/,
		);
	});

	it("degrades to a clear error without a control plane URL, without calling anything", async () => {
		const { fetchFn, request } = setup({}, { controlPlaneUrl: "" });
		const r = await request.execute("t1", args);
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/unavailable.*local dev/);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("EndResourceUpgrade", () => {
	it("posts to the revert route with only the mission id", async () => {
		const { fetchFn, end } = setup({ body: '{"ok":true,"action":"reverted"}' });
		const r = await end.execute("t1", {});
		expect(r.isError).toBeFalsy();
		const [url, init] = fetchFn.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(`${URL}/api/mission-copilot/resources/revert`);
		expect(JSON.parse(init.body as string)).toEqual({ missionId: "m1" });
	});

	it("relays a cooldown rejection", async () => {
		const { end } = setup({
			status: 429,
			body: '{"error":"resized less than 5 minutes ago"}',
		});
		const r = await end.execute("t1", {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});
