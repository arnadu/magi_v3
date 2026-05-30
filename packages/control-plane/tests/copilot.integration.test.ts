/**
 * Copilot agent integration test — template + skill authoring.
 *
 * Exercises the full copilot workflow:
 *   1. A pre-seeded mailbox message instructs the copilot to draft a
 *      2-agent char-count team template and a 'text-stats' platform skill.
 *   2. The daemon wakes immediately (pre-seeded message), runs a copilot turn
 *      that involves LLM planning, optional Bash tool calls, and ProposeAction.
 *   3. A copilot-action SSE event is pushed with the proposed save_template
 *      payload, including teamFiles.
 *   4. The test asserts the proposed template has the right structure:
 *      two agents (lead + worker), and a text-stats skill in teamFiles.
 *
 * Requires:
 *   - ANTHROPIC_API_KEY and MONGODB_URI in .env
 *   - config/teams/copilot.yaml to exist (already in the repo)
 *
 * The magi-copilot OS user is not required.  If the copilot tries Bash
 * and sudo fails, the inner loop continues and it drafts from its context.
 */

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMongoMailboxRepository } from "../../agent-runtime-worker/src/mailbox.js";
import { CLAUDE_SONNET } from "../../agent-runtime-worker/src/models.js";
import { connectMongo } from "../../agent-runtime-worker/src/mongo.js";
import { startCopilotDaemon } from "../src/copilot-daemon.js";
import { PendingActionsStore } from "../src/copilot-tools.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SaveTemplatePayload {
	id: string;
	name?: string;
	teamConfigYaml: string;
	teamFiles?: Array<{ path: string; content: string }>;
}

interface CopilotActionEvent {
	id: string;
	type: string;
	label: string;
	payload: SaveTemplatePayload;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("copilot daemon — template + skill authoring", () => {
	it("proposes a save_template action with two agents and a text-stats skill", async () => {
		const missionId = `copilot-test-${randomUUID()}`;
		// biome-ignore lint/style/noNonNullAssertion: required env var; vitest.setup.ts validates presence
		const MONGODB_URI = process.env.MONGODB_URI!;
		const modelId = process.env.MODEL ?? CLAUDE_SONNET.id;

		const { client, db } = await connectMongo(MONGODB_URI, "magi-test");
		const mailboxRepo = createMongoMailboxRepository(db, missionId);
		const pending = new PendingActionsStore();
		const events: Array<{ type: string; data: unknown }> = [];

		// Seed the message BEFORE starting the daemon so the first hasUnread()
		// check finds it immediately, avoiding the Change Stream timing race.
		await mailboxRepo.post({
			missionId,
			from: "user",
			to: ["copilot"],
			subject: "Create char-count template",
			body: [
				"Create a new team template for a 2-agent character-counting mission.",
				"",
				"Requirements:",
				"1. Template id: char-count-test",
				"2. Two agents:",
				'   - id: "lead", role: supervisor, delegates the task to the worker',
				'   - id: "worker", uses Bash with `wc -c` to count characters and reports back',
				"3. A team skill file at path skills/_team/text-stats/SKILL.md that teaches",
				"   agents to run `wc -l -w -c <file>` and return the counts as",
				"   {lines, words, chars}. Include a short Bash example.",
				"4. Include the skill in teamFiles.",
				"",
				"Propose saving the template using ProposeAction.",
				"Use the standard MAGI team YAML format with mission.id, mission.name,",
				"and agents list. Each agent needs id, name, role, and a brief systemPrompt.",
			].join("\n"),
		});

		const daemon = startCopilotDaemon(
			db,
			REPO_ROOT,
			modelId,
			(type, data) => events.push({ type, data }),
			pending,
			missionId,
		);

		try {
			// Poll the events array until the copilot proposes the save_template
			// action or we hit the 90 s deadline.
			let actionEvent: CopilotActionEvent | undefined;
			const deadline = Date.now() + 90_000;

			while (Date.now() < deadline && !actionEvent) {
				actionEvent = events
					.filter((e) => e.type === "copilot-action")
					.map((e) => e.data as CopilotActionEvent)
					.find(
						(d) =>
							d.type === "save_template" && d.payload?.id === "char-count-test",
					);
				if (!actionEvent) {
					await new Promise<void>((res) => setTimeout(res, 2_000));
				}
			}

			// ── Structural assertions ──────────────────────────────────────────

			if (!actionEvent) {
				// Print what the copilot actually said for diagnosis.
				const loopMsgs = events
					.filter((e) => e.type === "copilot-loop-msg")
					.map((e) => {
						const m = e.data as { role: string; content: unknown };
						const text =
							typeof m.content === "string"
								? m.content.slice(0, 400)
								: JSON.stringify(m.content).slice(0, 400);
						return `[${m.role}] ${text}`;
					});
				console.error(
					"[test] No save_template event. Loop messages:\n",
					loopMsgs.join("\n---\n"),
				);
				const allEvents = events.map((e) => e.type);
				console.error("[test] All event types:", allEvents);
			}

			expect(
				actionEvent,
				"expected a save_template ProposeAction for char-count-test",
			).toBeDefined();

			const payload = actionEvent?.payload;

			// teamConfigYaml must define at least two agents.
			const agentEntries = (payload.teamConfigYaml.match(/^\s*- id:/gm) ?? [])
				.length;
			expect(
				agentEntries,
				"teamConfigYaml must define 2 agents",
			).toBeGreaterThanOrEqual(2);

			// teamFiles must include the text-stats skill.
			expect(
				payload.teamFiles,
				"teamFiles must be present and non-empty",
			).toBeDefined();

			const skillFile = (payload.teamFiles ?? []).find((f) =>
				f.path.endsWith("SKILL.md"),
			);
			expect(
				skillFile,
				"teamFiles must contain a SKILL.md entry",
			).toBeDefined();

			// The skill must mention wc (the core tool it is supposed to teach).
			expect(skillFile?.content, "skill content must mention wc").toMatch(/wc/);
		} finally {
			daemon.stop();

			await db.collection("mailbox").deleteMany({ missionId });
			await db.collection("conversationMessages").deleteMany({ missionId });
			await db.collection("llmCallLog").deleteMany({ missionId });
			await client.close();
		}
	}, 120_000);
});
