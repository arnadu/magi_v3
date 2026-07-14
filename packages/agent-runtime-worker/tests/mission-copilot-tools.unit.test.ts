/**
 * Mission copilot elevated tools — unit tests (ADR-0016, Families A-F).
 *
 * No MongoDB, no LLM. Mongo access is faked with an in-memory collection
 * store; HTTP calls to the monitor server are faked via global.fetch.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMissionCopilotTools } from "../src/mission-copilot-tools.js";
import { readSupervisorNote } from "../src/supervisor-note.js";
import type { MagiTool } from "../src/tools.js";

// ---------------------------------------------------------------------------
// Fake Mongo — just enough surface for mission-copilot-tools.ts's queries.
// ---------------------------------------------------------------------------

function makeFakeDb(seed: Record<string, unknown[]> = {}) {
	const collections = new Map<string, unknown[]>(
		Object.entries(seed).map(([name, docs]) => [name, [...docs]]),
	);
	const updateOneCalls: Array<{
		collection: string;
		filter: unknown;
		update: unknown;
	}> = [];
	const insertOneCalls: Array<{ collection: string; doc: unknown }> = [];

	function getDocs(name: string): unknown[] {
		if (!collections.has(name)) collections.set(name, []);
		// biome-ignore lint/style/noNonNullAssertion: just set above if absent
		return collections.get(name)!;
	}

	/** Minimal operator support ($exists) — enough for this file's queries, not a real Mongo matcher. */
	function matches(
		doc: Record<string, unknown>,
		filter: Record<string, unknown>,
	): boolean {
		return Object.entries(filter).every(([k, v]) => {
			if (v && typeof v === "object" && "$exists" in v) {
				const wantExists = (v as { $exists: boolean }).$exists;
				return k in doc === wantExists;
			}
			if (v instanceof ObjectId) {
				return String(doc[k]) === String(v);
			}
			return doc[k] === v;
		});
	}

	const db = {
		collection(name: string) {
			return {
				async findOne(filter: Record<string, unknown>) {
					const docs = getDocs(name) as Array<Record<string, unknown>>;
					return docs.find((d) => matches(d, filter)) ?? null;
				},
				find(filter: Record<string, unknown> = {}) {
					let docs = (getDocs(name) as Array<Record<string, unknown>>).filter(
						(d) => matches(d, filter),
					);
					const chain = {
						sort(_s: unknown) {
							return chain;
						},
						limit(n: number) {
							docs = docs.slice(0, n);
							return chain;
						},
						async toArray() {
							return docs;
						},
					};
					return chain;
				},
				aggregate(_pipeline: unknown[]) {
					return {
						async toArray() {
							return [];
						},
					};
				},
				async updateOne(filter: unknown, update: unknown, _opts?: unknown) {
					updateOneCalls.push({ collection: name, filter, update });
					return { acknowledged: true };
				},
				async insertOne(doc: Record<string, unknown>) {
					const _id = new ObjectId();
					getDocs(name).push({ _id, ...doc });
					insertOneCalls.push({ collection: name, doc });
					return { acknowledged: true, insertedId: _id };
				},
				async deleteOne(filter: Record<string, unknown>) {
					const docs = getDocs(name) as Array<Record<string, unknown>>;
					const idx = docs.findIndex((d) => matches(d, filter));
					if (idx === -1) return { acknowledged: true, deletedCount: 0 };
					docs.splice(idx, 1);
					return { acknowledged: true, deletedCount: 1 };
				},
			};
		},
	};

	return { db, collections, updateOneCalls, insertOneCalls, getDocs };
}

function get(tools: MagiTool[], name: string): MagiTool {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool ${name} not found`);
	return tool;
}

describe("mission-copilot-tools", () => {
	let sharedDir: string;
	let mailboxPosts: Array<Record<string, unknown>>;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		sharedDir = mkdtempSync(join(tmpdir(), "mission-copilot-tools-"));
		mailboxPosts = [];
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		rmSync(sharedDir, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	function buildTools(
		dbOverride?: ReturnType<typeof makeFakeDb>["db"],
		cancelBackgroundJobImpl: (jobId: string) => boolean = () => false,
		controlPlaneUrl = "",
	) {
		const fake = makeFakeDb();
		const db = dbOverride ?? fake.db;
		const mailboxRepo = {
			async post(msg: Record<string, unknown>) {
				mailboxPosts.push(msg);
				return { id: "m1", timestamp: new Date(), readBy: [], ...msg };
			},
			async listUnread() {
				return [];
			},
			async markRead() {},
			async hasUnread() {
				return false;
			},
		};
		const tools = createMissionCopilotTools({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake Db surface for tests
			db: db as any,
			missionId: "m1",
			sharedDir,
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake MailboxRepository
			mailboxRepo: mailboxRepo as any,
			monitorPort: 4000,
			monitorToken: "test-token",
			teamAgentIds: ["lead", "worker", "copilot"],
			cancelBackgroundJob: cancelBackgroundJobImpl,
			controlPlaneUrl,
		});
		return { tools, fake };
	}

	// ── Zero-mission-id-param invariant ─────────────────────────────────────

	it("no tool's parameter schema declares a missionId field", () => {
		const { tools } = buildTools();
		for (const tool of tools) {
			const props = (
				tool.parameters as { properties?: Record<string, unknown> }
			).properties;
			expect(Object.keys(props ?? {})).not.toContain("missionId");
		}
	});

	// ── Family A ─────────────────────────────────────────────────────────────

	describe("ReadMissionConfig / SaveMissionConfig", () => {
		it("ReadMissionConfig returns the stored config with trust-boundary-marked team files", async () => {
			const fake = makeFakeDb({
				missions: [
					{
						missionId: "m1",
						teamConfigYaml: "mission:\n  id: m1\n",
						teamFiles: [{ path: "skills/x/SKILL.md", content: "do the thing" }],
					},
				],
			});
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "ReadMissionConfig").execute("t1", {});
			expect(result.isError).toBeFalsy();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.teamConfigYaml).toContain("mission:");
			expect(parsed.teamFiles[0].contentPreview).toContain(
				"TEAMMATE-AUTHORED CONTENT",
			);
			expect(parsed.teamFiles[0].contentPreview).toContain("do the thing");
		});

		it("SaveMissionConfig rejects invalid YAML without writing", async () => {
			const fake = makeFakeDb({ missions: [{ missionId: "m1" }] });
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "SaveMissionConfig").execute("t1", {
				teamConfigYaml: "not: valid: yaml: at: all: [",
			});
			expect(result.isError).toBe(true);
			expect(fake.updateOneCalls).toHaveLength(0);
		});

		it("SaveMissionConfig rejects an authored agent with the reserved copilot id", async () => {
			const fake = makeFakeDb({ missions: [{ missionId: "m1" }] });
			const { tools } = buildTools(fake.db);
			const yaml = [
				"mission:",
				"  id: m1",
				"  name: Test",
				"agents:",
				"  - id: copilot",
				"    supervisor: user",
				"    systemPrompt: x",
				"    initialMentalMap: <section></section>",
			].join("\n");
			const result = await get(tools, "SaveMissionConfig").execute("t1", {
				teamConfigYaml: yaml,
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("reserved");
			expect(fake.updateOneCalls).toHaveLength(0);
		});

		it("SaveMissionConfig writes on success and posts an audit message", async () => {
			const fake = makeFakeDb({ missions: [{ missionId: "m1" }] });
			const { tools } = buildTools(fake.db);
			const yaml = [
				"mission:",
				"  id: m1",
				"  name: Test",
				"agents:",
				"  - id: lead",
				"    supervisor: user",
				"    systemPrompt: x",
				"    initialMentalMap: <section></section>",
			].join("\n");
			const result = await get(tools, "SaveMissionConfig").execute("t1", {
				teamConfigYaml: yaml,
			});
			expect(result.isError).toBeFalsy();
			expect(fake.updateOneCalls).toHaveLength(1);
			expect(mailboxPosts).toHaveLength(1);
			expect(mailboxPosts[0].to).toEqual(["user"]);
		});
	});

	// ── Family E ─────────────────────────────────────────────────────────────

	describe("PauseAgent", () => {
		it("rejects targeting itself", async () => {
			const { tools } = buildTools();
			const result = await get(tools, "PauseAgent").execute("t1", {
				agentId: "copilot",
			});
			expect(result.isError).toBe(true);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("posts to the monitor and audits on success", async () => {
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify({ ok: true, paused: ["worker"] }), {
					status: 200,
				}),
			);
			const { tools } = buildTools();
			const result = await get(tools, "PauseAgent").execute("t1", {
				agentId: "worker",
			});
			expect(result.isError).toBeFalsy();
			expect(fetchMock).toHaveBeenCalledWith(
				"http://127.0.0.1:4000/pause-agent",
				expect.objectContaining({
					method: "POST",
					headers: expect.objectContaining({ "x-monitor-token": "test-token" }),
				}),
			);
			expect(mailboxPosts).toHaveLength(1);
		});
	});

	describe("EditAgentMentalMap", () => {
		it("rejects an agentId not in the current team roster", async () => {
			const { tools } = buildTools();
			const result = await get(tools, "EditAgentMentalMap").execute("t1", {
				agentId: "not-a-real-agent",
				note: "hello",
			});
			expect(result.isError).toBe(true);
			expect(
				await readSupervisorNote(sharedDir, "not-a-real-agent"),
			).toBeNull();
		});

		it("writes the note file and posts an audit message with the note's exact text", async () => {
			const { tools } = buildTools();
			const result = await get(tools, "EditAgentMentalMap").execute("t1", {
				agentId: "worker",
				note: "You've drifted from OBJ-1 — please re-read it.",
			});
			expect(result.isError).toBeFalsy();
			const note = await readSupervisorNote(sharedDir, "worker");
			expect(note?.note).toBe("You've drifted from OBJ-1 — please re-read it.");
			expect(note?.by).toBe("copilot");
			expect(mailboxPosts).toHaveLength(1);
			expect(mailboxPosts[0].body).toContain(
				"You've drifted from OBJ-1 — please re-read it.",
			);
		});
	});

	describe("CreateScheduledMessage / CancelScheduledMessage / ListScheduledMessages", () => {
		it("CreateScheduledMessage writes the real scheduler.ts-compatible schema and audits", async () => {
			const fake = makeFakeDb();
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "CreateScheduledMessage").execute("t1", {
				to: ["worker"],
				subject: "Daily check-in",
				cron: "0 6 * * *",
			});
			expect(result.isError).toBeFalsy();
			expect(fake.insertOneCalls).toHaveLength(1);
			const doc = fake.insertOneCalls[0].doc as Record<string, unknown>;
			// Field names must match scheduler.ts's deliver() reader exactly —
			// an earlier draft of this tool copied monitor-server.ts's
			// unrelated (buggy) scheduledFor/cronExpression field names, which
			// scheduler.ts never reads.
			expect(doc.missionId).toBe("m1");
			expect(doc.to).toEqual(["worker"]);
			expect(doc.cron).toBe("0 6 * * *");
			expect(doc.status).toBe("pending");
			expect(doc.deliverAt).toBeInstanceOf(Date);
			expect(mailboxPosts).toHaveLength(1);
		});

		it("ListScheduledMessages reads back what CreateScheduledMessage wrote", async () => {
			const fake = makeFakeDb();
			const { tools } = buildTools(fake.db);
			await get(tools, "CreateScheduledMessage").execute("t1", {
				to: ["worker"],
				subject: "Daily check-in",
				cron: "0 6 * * *",
				label: "daily-checkin",
			});
			const result = await get(tools, "ListScheduledMessages").execute(
				"t1",
				{},
			);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed).toHaveLength(1);
			expect(parsed[0].subject).toBe("Daily check-in");
			expect(parsed[0].cron).toBe("0 6 * * *");
			expect(parsed[0].label).toBe("daily-checkin");
		});

		it("CancelScheduledMessage is scoped to this mission — cannot cancel another mission's schedule", async () => {
			const otherMissionId = new ObjectId();
			const fake = makeFakeDb({
				scheduled_messages: [
					{
						_id: otherMissionId,
						missionId: "other-mission",
						status: "pending",
					},
				],
			});
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "CancelScheduledMessage").execute("t1", {
				id: otherMissionId.toHexString(),
			});
			expect(result.isError).toBe(true);
			expect(fake.getDocs("scheduled_messages")).toHaveLength(1);
		});

		it("CancelScheduledMessage deletes its own mission's schedule and audits", async () => {
			const id = new ObjectId();
			const fake = makeFakeDb({
				scheduled_messages: [{ _id: id, missionId: "m1", status: "pending" }],
			});
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "CancelScheduledMessage").execute("t1", {
				id: id.toHexString(),
			});
			expect(result.isError).toBeFalsy();
			expect(fake.getDocs("scheduled_messages")).toHaveLength(0);
			expect(mailboxPosts).toHaveLength(1);
		});

		it("CancelScheduledMessage rejects a malformed id without throwing", async () => {
			const { tools } = buildTools();
			const result = await get(tools, "CancelScheduledMessage").execute("t1", {
				id: "not-a-valid-object-id",
			});
			expect(result.isError).toBe(true);
		});
	});

	describe("CancelBackgroundJob / RestartBackgroundJob / ListBackgroundJobs", () => {
		it("CancelBackgroundJob reports failure (not a thrown error) when the job isn't running", async () => {
			const { tools } = buildTools(undefined, () => false);
			const result = await get(tools, "CancelBackgroundJob").execute("t1", {
				jobId: "job-1",
			});
			expect(result.isError).toBe(true);
			expect(mailboxPosts).toHaveLength(0);
		});

		it("CancelBackgroundJob calls the registry callback and audits on success", async () => {
			const calls: string[] = [];
			const { tools } = buildTools(undefined, (jobId) => {
				calls.push(jobId);
				return true;
			});
			const result = await get(tools, "CancelBackgroundJob").execute("t1", {
				jobId: "job-1",
			});
			expect(result.isError).toBeFalsy();
			expect(calls).toEqual(["job-1"]);
			expect(mailboxPosts).toHaveLength(1);
		});

		it("RestartBackgroundJob errors clearly when no completed job matches the id", async () => {
			const { tools } = buildTools();
			const result = await get(tools, "RestartBackgroundJob").execute("t1", {
				jobId: "never-ran",
			});
			expect(result.isError).toBe(true);
		});

		it("RestartBackgroundJob resubmits the original spec as a new pending job", async () => {
			const { mkdir, writeFile } = await import("node:fs/promises");
			const statusDir = join(sharedDir, "jobs", "status");
			await mkdir(statusDir, { recursive: true });
			await writeFile(
				join(statusDir, "old-job.json"),
				JSON.stringify({
					id: "old-job",
					agentId: "worker",
					scriptPath: "/shared/scripts/refresh.py",
					args: ["--full"],
					notifyAgentId: "worker",
					exitCode: 1,
					completedAt: new Date().toISOString(),
				}),
				"utf8",
			);
			const { tools } = buildTools();
			const result = await get(tools, "RestartBackgroundJob").execute("t1", {
				jobId: "old-job",
			});
			expect(result.isError).toBeFalsy();
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed.newJobId).toBeTruthy();
			expect(parsed.newJobId).not.toBe("old-job");

			const { readFile, readdir } = await import("node:fs/promises");
			const pendingFiles = await readdir(join(sharedDir, "jobs", "pending"));
			expect(pendingFiles).toEqual([`${parsed.newJobId}.json`]);
			const newSpec = JSON.parse(
				await readFile(
					join(sharedDir, "jobs", "pending", `${parsed.newJobId}.json`),
					"utf8",
				),
			);
			expect(newSpec.agentId).toBe("worker");
			expect(newSpec.scriptPath).toBe("/shared/scripts/refresh.py");
			expect(newSpec.args).toEqual(["--full"]);
			expect(mailboxPosts).toHaveLength(1);
		});

		it("ListBackgroundJobs reports pending, running, and completed jobs from their respective directories", async () => {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(sharedDir, "jobs", "pending"), { recursive: true });
			await mkdir(join(sharedDir, "jobs", "running"), { recursive: true });
			await mkdir(join(sharedDir, "jobs", "status"), { recursive: true });
			await writeFile(
				join(sharedDir, "jobs", "pending", "p1.json"),
				JSON.stringify({ id: "p1", agentId: "worker", scriptPath: "a.py" }),
			);
			await writeFile(
				join(sharedDir, "jobs", "running", "r1.json"),
				JSON.stringify({ id: "r1", agentId: "worker", scriptPath: "b.py" }),
			);
			await writeFile(
				join(sharedDir, "jobs", "status", "s1.json"),
				JSON.stringify({
					id: "s1",
					agentId: "worker",
					scriptPath: "c.py",
					exitCode: 0,
				}),
			);
			await writeFile(
				join(sharedDir, "jobs", "status", "s2.json"),
				JSON.stringify({
					id: "s2",
					agentId: "worker",
					scriptPath: "d.py",
					exitCode: 1,
				}),
			);
			const { tools } = buildTools();
			const result = await get(tools, "ListBackgroundJobs").execute("t1", {});
			const parsed = JSON.parse(result.content[0].text) as Array<{
				id: string;
				status: string;
			}>;
			const byId = Object.fromEntries(parsed.map((j) => [j.id, j.status]));
			expect(byId.p1).toBe("pending");
			expect(byId.r1).toBe("running");
			expect(byId.s1).toBe("completed");
			expect(byId.s2).toBe("failed");
		});
	});

	// ── Trust-boundary marking spot checks ──────────────────────────────────

	describe("trust-boundary marking", () => {
		it("ReadAgentMentalMap wraps the returned HTML", async () => {
			const fake = makeFakeDb({
				conversationMessages: [
					{
						agentId: "worker",
						missionId: "m1",
						mentalMapHtml: "<section id='tasks'>do the thing</section>",
						turnNumber: 1,
						seqInTurn: 0,
					},
				],
			});
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "ReadAgentMentalMap").execute("t1", {
				agentId: "worker",
			});
			expect(result.content[0].text).toContain("TEAMMATE-AUTHORED CONTENT");
			expect(result.content[0].text).toContain("do the thing");
		});

		it("ReadMissionMailboxAll wraps the returned messages", async () => {
			const fake = makeFakeDb({
				mailbox: [
					{
						missionId: "m1",
						from: "worker",
						to: ["user"],
						subject: "status",
						body: "all good",
						timestamp: new Date(),
					},
				],
			});
			const { tools } = buildTools(fake.db);
			const result = await get(tools, "ReadMissionMailboxAll").execute(
				"t1",
				{},
			);
			expect(result.content[0].text).toContain("TEAMMATE-AUTHORED CONTENT");
			expect(result.content[0].text).toContain("all good");
		});
	});

	// ── ListAgentSessions / ReadAgentUsage (HTTP thin wrappers) ─────────────

	describe("ListAgentSessions", () => {
		it("fetches the monitor route and applies the limit client-side", async () => {
			const sessions = Array.from({ length: 5 }, (_, i) => ({ turnNumber: i }));
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify(sessions), { status: 200 }),
			);
			const { tools } = buildTools();
			const result = await get(tools, "ListAgentSessions").execute("t1", {
				agentId: "worker",
				limit: 2,
			});
			expect(fetchMock).toHaveBeenCalledWith(
				"http://127.0.0.1:4000/agents/worker/sessions",
				expect.anything(),
			);
			const parsed = JSON.parse(result.content[0].text);
			expect(parsed).toEqual([{ turnNumber: 3 }, { turnNumber: 4 }]);
		});
	});

	describe("ListGithubIssues / ReportGithubIssue", () => {
		it("errors clearly (not a throw) when no control plane URL is configured", async () => {
			const { tools } = buildTools(undefined, undefined, "");
			const result = await get(tools, "ListGithubIssues").execute("t1", {});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("unavailable");
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("ListGithubIssues sends missionId and the monitor token to the proxy", async () => {
			fetchMock.mockResolvedValue(
				new Response(JSON.stringify([{ number: 1 }]), { status: 200 }),
			);
			const { tools } = buildTools(
				undefined,
				undefined,
				"https://control.example",
			);
			await get(tools, "ListGithubIssues").execute("t1", { query: "bug" });
			const [url, init] = fetchMock.mock.calls[0];
			expect(String(url)).toContain(
				"https://control.example/api/mission-copilot/github/issues?",
			);
			expect(String(url)).toContain("missionId=m1");
			expect(String(url)).toContain("query=bug");
			expect((init as RequestInit).headers).toMatchObject({
				"x-monitor-token": "test-token",
			});
		});

		it("ReportGithubIssue posts missionId/title/body/labels to the proxy", async () => {
			fetchMock.mockResolvedValue(
				new Response(
					JSON.stringify({ ok: true, issueNumber: 42, url: "https://x" }),
					{ status: 200 },
				),
			);
			const { tools } = buildTools(
				undefined,
				undefined,
				"https://control.example",
			);
			const result = await get(tools, "ReportGithubIssue").execute("t1", {
				title: "Bug",
				body: "Details",
			});
			expect(result.isError).toBeFalsy();
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toBe(
				"https://control.example/api/mission-copilot/github/issue",
			);
			const sentBody = JSON.parse((init as RequestInit).body as string);
			expect(sentBody).toEqual({
				missionId: "m1",
				title: "Bug",
				body: "Details",
				labels: undefined,
			});
		});

		it("surfaces a non-OK proxy response as a tool error, not a throw", async () => {
			fetchMock.mockResolvedValue(
				new Response("Unauthorized", { status: 401 }),
			);
			const { tools } = buildTools(
				undefined,
				undefined,
				"https://control.example",
			);
			const result = await get(tools, "ReportGithubIssue").execute("t1", {
				title: "Bug",
				body: "Details",
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("401");
		});
	});
});
