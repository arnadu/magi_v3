/**
 * Copilot agent integration test — template selection + mission launch.
 *
 * ADR-0021 note: templates became immutable, disk-only, read-only (no more
 * `save_template`/template authoring). This test replaces the old
 * "copilot drafts a brand-new template from scratch" scenario (no longer
 * possible — that capability was deliberately cut) with what the copilot
 * actually does now: read the available templates and propose launching a
 * mission from the one that best matches the operator's request.
 *
 * Exercises the full copilot workflow:
 *   1. A pre-seeded mailbox message asks the copilot to launch a mission
 *      from the repo's own "general-assistant" template.
 *   2. The daemon wakes immediately (pre-seeded message), runs a copilot turn
 *      that calls ListTemplates/GetTemplate and then ProposeAction.
 *   3. A copilot-action SSE event is pushed with the proposed launch_mission
 *      payload.
 *   4. The test asserts the proposal references the right templateId — it
 *      does not confirm/execute the action (no machine is provisioned).
 *
 * Requires:
 *   - ANTHROPIC_API_KEY and MONGODB_URI in .env
 *   - config/teams/general-assistant.yaml to exist (already in the repo)
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
import { loadTemplates } from "../src/templates.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LaunchMissionPayload {
	missionId: string;
	name?: string;
	templateId: string;
}

interface CopilotActionEvent {
	id: string;
	type: string;
	label: string;
	payload: LaunchMissionPayload;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("copilot daemon — template selection + mission launch", () => {
	it("proposes a launch_mission action for the requested template", async () => {
		// Templates are loaded once at control-plane startup in production
		// (index.ts); this test runs the copilot daemon standalone, so it must
		// populate the in-memory template store itself before the copilot's
		// ListTemplates/GetTemplate tools have anything to read.
		loadTemplates(REPO_ROOT);

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
			subject: "Launch a general-assistant mission",
			body: [
				"List the available mission templates, then launch a new mission from",
				'the one with id "general-assistant".',
				"",
				`Use missionId "${missionId}-launch" for the new mission.`,
				"Propose the launch using ProposeAction with type launch_mission.",
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
			// Poll the events array until the copilot proposes the launch_mission
			// action or we hit the 90 s deadline.
			let actionEvent: CopilotActionEvent | undefined;
			const deadline = Date.now() + 90_000;

			while (Date.now() < deadline && !actionEvent) {
				actionEvent = events
					.filter((e) => e.type === "copilot-action")
					.map((e) => e.data as CopilotActionEvent)
					.find(
						(d) =>
							d.type === "launch_mission" &&
							d.payload?.templateId === "general-assistant",
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
					"[test] No launch_mission event. Loop messages:\n",
					loopMsgs.join("\n---\n"),
				);
				const allEvents = events.map((e) => e.type);
				console.error("[test] All event types:", allEvents);
			}

			expect(
				actionEvent,
				"expected a launch_mission ProposeAction for templateId general-assistant",
			).toBeDefined();

			const payload = actionEvent?.payload;
			expect(payload?.missionId).toBeTruthy();
			expect(payload?.templateId).toBe("general-assistant");
		} finally {
			daemon.stop();

			await db.collection("mailbox").deleteMany({ missionId });
			await db.collection("conversationMessages").deleteMany({ missionId });
			await db.collection("llmCallLog").deleteMany({ missionId });
			await client.close();
		}
	}, 120_000);
});
