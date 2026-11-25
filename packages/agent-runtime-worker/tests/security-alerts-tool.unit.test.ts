/**
 * SecurityAlerts (security.read-alerts) on the mission side: what it sends the control plane,
 * and that a job of an agent the mission does not name cannot reach it through the Tool API.
 * The control plane's own check is tested in control-plane/tests/github-alerts.unit.test.ts.
 */
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { CLAUDE_HAIKU, CLAUDE_SONNET } from "../src/models.js";
import { ToolApiServer } from "../src/tool-api-server.js";
import { createSecurityAlertsTool } from "../src/tools/security-alerts.js";

function client(status: number, body: string) {
	const calls: { url: string; token: string }[] = [];
	return {
		calls,
		client: {
			controlPlaneUrl: "https://cp.example",
			monitorToken: "mission-token",
			missionId: "magi-dev-1",
			fetch: (async (url: string, init?: RequestInit) => {
				calls.push({
					url,
					token: (init?.headers as Record<string, string>)["x-monitor-token"],
				});
				return new Response(body, { status });
			}) as unknown as typeof fetch,
		},
	};
}

describe("SecurityAlerts", () => {
	it("asks the control plane as this mission and agent, with the mission token", async () => {
		const c = client(200, '{"alerts":[]}');
		const r = await createSecurityAlertsTool(c.client, "appsec").execute(
			"1",
			{},
		);
		expect(r.isError).toBeFalsy();
		expect((r.content[0] as { text: string }).text).toBe('{"alerts":[]}');
		expect(c.calls[0].url).toBe(
			"https://cp.example/api/mission-copilot/github/alerts?missionId=magi-dev-1&agentId=appsec",
		);
		expect(c.calls[0].token).toBe("mission-token");
	});

	it("reports a refusal as not allowed, and works without a control plane only to say so", async () => {
		const r = await createSecurityAlertsTool(
			client(404, "{}").client,
			"appsec",
		).execute("1", {});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toMatch(/not allowed/);
		const local = await createSecurityAlertsTool(
			{ ...client(200, "").client, controlPlaneUrl: "" },
			"appsec",
		).execute("1", {});
		expect(local.isError).toBe(true);
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

describe("the Tool API's security-alerts", () => {
	it("is there for a named agent's job and unknown to any other", async () => {
		const c = client(200, '{"alerts":[]}');
		const server = new ToolApiServer(
			CLAUDE_SONNET,
			CLAUDE_HAIKU,
			"/tmp/magi-tool-api-alerts",
			{ post: async () => {} } as never,
			{
				mission: { id: "m1", name: "t" },
				agents: [{ id: "appsec" }, { id: "documenter" }],
			} as never,
			{ meterFor: () => async () => {}, isBudgetPaused: () => false },
			{ agents: ["appsec"], client: c.client },
		);
		const port = await freePort();
		server.listen(port);
		await new Promise((r) => setTimeout(r, 50));
		try {
			const call = (agentId: string) => {
				const token = server.issueToken(
					{ agentId, linuxUser: agentId, permittedPaths: ["/tmp"] },
					{ workdir: "/tmp", sharedDir: "/tmp", linuxUser: agentId },
				);
				return fetch(`http://127.0.0.1:${port}/tools/security-alerts`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: "{}",
				});
			};
			const ok = await call("appsec");
			expect(ok.status).toBe(200);
			const refused = await call("documenter");
			expect(refused.status).toBe(404);
			expect(((await refused.json()) as { error: string }).error).toMatch(
				/unknown tool/,
			);
			expect(c.calls).toHaveLength(1);
		} finally {
			server.stop();
		}
	});
});
