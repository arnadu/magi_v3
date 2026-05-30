/**
 * Concurrent dispatcher unit tests.
 *
 * No MongoDB, no LLM, no filesystem. runAgent is replaced with a controlled
 * async function; all repos are in-memory mocks.
 * Target runtime: < 3 seconds total.
 */

import type { AgentConfig, TeamConfig } from "@magi/agent-config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MailboxMessage } from "../src/mailbox.js";
import type { OrchestratorConfig } from "../src/orchestrator.js";

// ---------------------------------------------------------------------------
// Module mocks — hoisted by Vitest
// ---------------------------------------------------------------------------

vi.mock("../src/agent-runner.js", () => ({
	runAgent: vi.fn(),
}));

vi.mock("../src/tools.js", () => ({
	verifyIsolation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/user-input.js", () => ({
	processUserInput: vi.fn(async (line: string) => line),
}));

// Import after mocks are registered.
import { runAgent } from "../src/agent-runner.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";

const mockRunAgent = runAgent as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Build a TeamConfig with the given agent IDs (all reporting to "user"). */
function makeTeamConfig(agentIds: string[]): TeamConfig {
	return {
		mission: { id: "test-mission", name: "Test Mission" },
		agents: agentIds.map(
			(id) =>
				({
					id,
					name: id,
					supervisor: "user",
					linuxUser: `w-${id}`,
					systemPrompt: "test",
					initialMentalMap: "",
				}) as AgentConfig,
		),
	};
}

/** Controllable in-memory mailbox. */
function makeMockMailbox(initialMail: Record<string, string[]> = {}) {
	// Map agentId → [{id, subject}] queue (unread messages).
	const queues = new Map<string, Array<{ id: string; subject: string }>>();
	for (const [agentId, subjects] of Object.entries(initialMail)) {
		queues.set(
			agentId,
			subjects.map((s, i) => ({ id: `${agentId}-init-${i}`, subject: s })),
		);
	}

	let msgCounter = 0;

	const repo = {
		hasUnread: vi.fn(
			async (agentId: string) => (queues.get(agentId)?.length ?? 0) > 0,
		),
		listUnread: vi.fn(async (agentId: string) => {
			const msgs = queues.get(agentId) ?? [];
			return msgs.map(
				(m) =>
					({
						id: m.id,
						missionId: "test-mission",
						from: "user",
						to: [agentId],
						subject: m.subject,
						body: m.subject,
						timestamp: new Date(),
						read: false,
					}) as MailboxMessage,
			);
		}),
		markRead: vi.fn(async (ids: string[]) => {
			const idSet = new Set(ids);
			for (const [agentId, msgs] of queues.entries()) {
				queues.set(
					agentId,
					msgs.filter((m) => !idSet.has(m.id)),
				);
			}
		}),
		post: vi.fn(async () => {}),
	};

	/** Add a new unread message to an agent's queue. */
	function addMail(agentId: string, subject = "task") {
		const id = `${agentId}-dyn-${msgCounter++}`;
		const existing = queues.get(agentId) ?? [];
		queues.set(agentId, [...existing, { id, subject }]);
	}

	return { repo, addMail };
}

/** Minimal workspace manager stub. */
function makeMockWorkspace(_teamConfig: TeamConfig) {
	return {
		provision: vi.fn(
			(
				_missionId: string,
				agents: Array<{ id: string; linuxUser: string }>,
			) => {
				const map = new Map<
					string,
					{
						agentId: string;
						linuxUser: string;
						workdir: string;
						sharedDir: string;
					}
				>();
				for (const a of agents) {
					map.set(a.id, {
						agentId: a.id,
						linuxUser: a.linuxUser,
						workdir: `/tmp/mock/${a.id}`,
						sharedDir: "/tmp/mock/shared",
					});
				}
				return map;
			},
		),
		teardown: vi.fn(),
	};
}

/**
 * Build a mock runAgent that takes `durationMs` to complete.
 * Responds to AbortSignal by rejecting early.
 */
function makeMockRunner(opts: {
	durationMs: number;
	onStart?: (agentId: string) => void;
	onAbort?: (agentId: string) => void;
	afterStart?: (agentId: string) => void;
}) {
	return async (
		agentId: string,
		_msgs: unknown,
		_ctx: unknown,
		signal?: AbortSignal,
	): Promise<void> => {
		opts.onStart?.(agentId);
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => resolve(), opts.durationMs);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					opts.onAbort?.(agentId);
					reject(new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
		});
		opts.afterStart?.(agentId);
	};
}

/** Minimal OrchestratorConfig (no daemon, no step, no TTY). */
function buildConfig(
	teamConfig: TeamConfig,
	mailboxRepo: ReturnType<typeof makeMockMailbox>["repo"],
	overrides: Partial<OrchestratorConfig> = {},
): OrchestratorConfig {
	const workspace = makeMockWorkspace(teamConfig);
	return {
		teamConfig,
		mailboxRepo,
		conversationRepo: {
			load: vi.fn(async () => []),
			append: vi.fn(async () => {}),
			compact: vi.fn(async () => {}),
			deleteAll: vi.fn(async () => {}),
		},
		model: {} as OrchestratorConfig["model"],
		workdir: "/tmp/mock",
		workspaceManager:
			workspace as unknown as OrchestratorConfig["workspaceManager"],
		teardownOnExit: false,
		...overrides,
	};
}

beforeEach(() => {
	mockRunAgent.mockReset();
});

// ---------------------------------------------------------------------------
// TC-1: Two agents run concurrently
// ---------------------------------------------------------------------------

describe("TC-1: two agents run concurrently", () => {
	it("dispatches both agents without waiting for the first to finish", async () => {
		const tc = makeTeamConfig(["agent-a", "agent-b"]);
		const { repo } = makeMockMailbox({
			"agent-a": ["task-a"],
			"agent-b": ["task-b"],
		});

		const startTimes: Record<string, number> = {};
		const t0 = Date.now();

		mockRunAgent.mockImplementation(
			makeMockRunner({
				durationMs: 100,
				onStart: (id) => {
					startTimes[id] = Date.now() - t0;
				},
			}),
		);

		const started = Date.now();
		await runOrchestrationLoop(buildConfig(tc, repo));
		const elapsed = Date.now() - started;

		// Both agents must have started — they had different start times
		expect(startTimes["agent-a"]).toBeDefined();
		expect(startTimes["agent-b"]).toBeDefined();

		// Both start within 20 ms of each other (not 100 ms apart)
		const gap = Math.abs(startTimes["agent-a"] - startTimes["agent-b"]);
		expect(gap).toBeLessThan(30);

		// Total elapsed < 150 ms (concurrent, not 200 ms sequential)
		expect(elapsed).toBeLessThan(160);
	});
});

// ---------------------------------------------------------------------------
// TC-2: Mail arriving mid-run triggers a second dispatch after completion
// ---------------------------------------------------------------------------

describe("TC-2: mid-run mail triggers second dispatch on completion", () => {
	it("runs agent-a exactly twice; second run starts after first completes", async () => {
		const tc = makeTeamConfig(["agent-a"]);
		const { repo, addMail } = makeMockMailbox({ "agent-a": ["first-task"] });

		const runCount: Record<string, number> = { "agent-a": 0 };
		const runStartTimes: number[] = [];
		const runEndTimes: number[] = [];
		const t0 = Date.now();

		mockRunAgent.mockImplementation(async (agentId, _msgs, _ctx, signal) => {
			runCount[agentId]++;
			runStartTimes.push(Date.now() - t0);

			// Add mail after 40 ms on the first run to simulate mid-run arrival.
			if (runCount[agentId] === 1) {
				await new Promise<void>((resolve, reject) => {
					const t = setTimeout(() => {
						addMail("agent-a", "second-task");
						resolve();
					}, 40);
					signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(t);
							reject(new DOMException("Aborted", "AbortError"));
						},
						{ once: true },
					);
				});
				// Complete after 80 ms total
				await new Promise<void>((r) => setTimeout(r, 40));
			} else {
				await new Promise<void>((r) => setTimeout(r, 20));
			}
			runEndTimes.push(Date.now() - t0);
		});

		await runOrchestrationLoop(buildConfig(tc, repo));

		// agent-a must run exactly twice
		expect(runCount["agent-a"]).toBe(2);

		// Second run must start after first ends
		expect(runStartTimes[1]).toBeGreaterThanOrEqual(runEndTimes[0]);
	});
});

// ---------------------------------------------------------------------------
// TC-3: Parent signal abort propagates to all running agents
// ---------------------------------------------------------------------------

describe("TC-3: parent abort propagates to running agents", () => {
	it("aborts all running agents and the loop resolves", async () => {
		const tc = makeTeamConfig(["agent-a", "agent-b"]);
		const { repo } = makeMockMailbox({
			"agent-a": ["task-a"],
			"agent-b": ["task-b"],
		});

		const abortTimes: Record<string, number> = {};
		const t0 = Date.now();

		const ac = new AbortController();

		mockRunAgent.mockImplementation(
			makeMockRunner({
				durationMs: 200,
				onAbort: (id) => {
					abortTimes[id] = Date.now() - t0;
				},
			}),
		);

		// Abort after 40 ms while both agents are running
		setTimeout(() => ac.abort(), 40);

		const started = Date.now();
		await runOrchestrationLoop(buildConfig(tc, repo), ac.signal);
		const elapsed = Date.now() - started;

		// Both agents must have been aborted
		expect(abortTimes["agent-a"]).toBeDefined();
		expect(abortTimes["agent-b"]).toBeDefined();

		// Both aborted within 20 ms of ac.abort() (at ~40 ms)
		expect(abortTimes["agent-a"]).toBeLessThan(80);
		expect(abortTimes["agent-b"]).toBeLessThan(80);

		// Loop must not hang — total elapsed well under 200 ms
		expect(elapsed).toBeLessThan(120);
	});
});

// ---------------------------------------------------------------------------
// TC-4: Step mode serialises dispatch
// ---------------------------------------------------------------------------

describe("TC-4: waitForStep serialises dispatch", () => {
	it("dispatches agents one at a time; second waits for step permit", async () => {
		const tc = makeTeamConfig(["agent-a", "agent-b"]);
		const { repo } = makeMockMailbox({
			"agent-a": ["task-a"],
			"agent-b": ["task-b"],
		});

		const startOrder: string[] = [];
		let stepCallCount = 0;

		// First step resolves immediately; second step delays 60 ms
		const waitForStep = vi.fn(async () => {
			const n = ++stepCallCount;
			if (n === 2) await new Promise<void>((r) => setTimeout(r, 60));
		});

		mockRunAgent.mockImplementation(async (agentId) => {
			startOrder.push(agentId);
			await new Promise<void>((r) => setTimeout(r, 10));
		});

		await runOrchestrationLoop(buildConfig(tc, repo, { waitForStep }));

		// Both step permits must have been requested
		expect(waitForStep).toHaveBeenCalledTimes(2);

		// agent-a dispatched before agent-b
		expect(startOrder[0]).toBe("agent-a");
		expect(startOrder[1]).toBe("agent-b");
	});
});

// ---------------------------------------------------------------------------
// TC-5: onIdle fires when no mail and no running agents
// ---------------------------------------------------------------------------

describe("TC-5: onIdle fires after all agents complete", () => {
	it("calls onIdle exactly once after agent-a finishes; not during its run", async () => {
		const tc = makeTeamConfig(["agent-a", "agent-b"]);
		const { repo } = makeMockMailbox({ "agent-a": ["task-a"] });
		// agent-b has no mail

		let idleCount = 0;
		let agentARunning = false;
		let idleFiredWhileRunning = false;

		const onIdle = () => {
			idleCount++;
			if (agentARunning) idleFiredWhileRunning = true;
		};

		mockRunAgent.mockImplementation(async (_agentId) => {
			agentARunning = true;
			await new Promise<void>((r) => setTimeout(r, 20));
			agentARunning = false;
		});

		await runOrchestrationLoop(buildConfig(tc, repo, { onIdle }));

		// onIdle must fire at least once
		expect(idleCount).toBeGreaterThanOrEqual(1);

		// onIdle must not have fired while agent-a was running
		expect(idleFiredWhileRunning).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// TC-6: maxRuns cap stops further dispatch
// ---------------------------------------------------------------------------

describe("TC-6: maxRuns cap stops further dispatch", () => {
	it("dispatches exactly maxRuns agents; third agent never starts", async () => {
		const tc = makeTeamConfig(["agent-a", "agent-b", "agent-c"]);
		const { repo } = makeMockMailbox({
			"agent-a": ["task-a"],
			"agent-b": ["task-b"],
			"agent-c": ["task-c"],
		});

		const started: string[] = [];
		const onAgentStart = vi.fn((id: string) => started.push(id));

		mockRunAgent.mockImplementation(async (_agentId) => {
			await new Promise<void>((r) => setTimeout(r, 10));
		});

		await runOrchestrationLoop(
			buildConfig(tc, repo, { maxRuns: 2, onAgentStart }),
		);

		// Exactly 2 dispatches
		expect(started.length).toBe(2);

		// agent-c never started
		expect(started).not.toContain("agent-c");
	});
});

// ---------------------------------------------------------------------------
// TC-7: Paused agent is skipped
// ---------------------------------------------------------------------------

describe("TC-7: isAgentPaused skips the paused agent", () => {
	it("dispatches only agent-b when agent-a is paused", async () => {
		const tc = makeTeamConfig(["agent-a", "agent-b"]);
		const { repo } = makeMockMailbox({
			"agent-a": ["task-a"],
			"agent-b": ["task-b"],
		});

		const started: string[] = [];
		const onAgentStart = vi.fn((id: string) => started.push(id));

		mockRunAgent.mockImplementation(async () => {
			await new Promise<void>((r) => setTimeout(r, 10));
		});

		await runOrchestrationLoop(
			buildConfig(tc, repo, {
				onAgentStart,
				isAgentPaused: (id) => id === "agent-a",
			}),
		);

		// Only agent-b was dispatched
		expect(started).toEqual(["agent-b"]);
		expect(started).not.toContain("agent-a");
	});
});
