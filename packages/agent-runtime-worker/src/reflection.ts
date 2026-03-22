/**
 * Sprint 9 — Context Management: Reflection and Tool-Result Scoping.
 *
 * This file is a stub that wires the reflection call site into agent-runner.ts
 * without implementing the reflection logic. The reflection integration test
 * (tests/reflection.integration.test.ts) will fail on its MongoDB assertions
 * until the real implementation is added.
 *
 * See ADR-0009 for the full design.
 */

import type { Message, Model } from "@mariozechner/pi-ai";
import type {
	ConversationRepository,
	StoredMessage,
} from "./conversation-repository.js";
import type { MentalMapRepository } from "./mental-map.js";

// ---------------------------------------------------------------------------
// Constants (injectable via env for integration tests)
// ---------------------------------------------------------------------------

/** Number of most-recent turns for which high-volume tool results are kept verbatim. */
export const KEEP_FULL_TURNS = Number(process.env.REFLECTION_KEEP_TURNS ?? 2);

/** Mid-session token estimate threshold that triggers an early reflection. */
export const MID_SESSION_THRESHOLD = Number(
	process.env.REFLECTION_THRESHOLD ?? 80_000,
);

// ---------------------------------------------------------------------------
// Tool-result scoping
// ---------------------------------------------------------------------------

const HIGH_VOLUME_TOOLS = new Set([
	"FetchUrl",
	"BrowseWeb",
	"Bash",
	"SearchWeb",
	"InspectImage",
]);

/**
 * Filter stored conversation history before passing to the LLM.
 *
 * Sprint 9: will collapse high-volume tool-result bodies for turns older than
 * KEEP_FULL_TURNS into a one-line placeholder. Currently a pass-through.
 */
export function convertToLlm(
	stored: StoredMessage[],
	_currentTurnNumber: number,
): Message[] {
	// TODO Sprint 9: implement collapsing logic per ADR-0009 § 1.
	// HIGH_VOLUME_TOOLS is referenced here to prevent the "unused import" lint
	// error and to make the intended filtering scope explicit.
	void HIGH_VOLUME_TOOLS;
	return stored.map((s) => s.message);
}

// ---------------------------------------------------------------------------
// Reflection output parsing
// ---------------------------------------------------------------------------

export interface ReflectionResult {
	patches: Array<{ id: string; content: string }>;
	summary: string;
}

export function parseReflection(text: string): ReflectionResult {
	const patches = [
		...text.matchAll(/<patch id="([^"]+)">([\s\S]*?)<\/patch>/g),
	].map((m) => ({ id: m[1], content: m[2].trim() }));
	const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/);
	return {
		patches,
		summary: summaryMatch?.[1].trim() ?? "",
	};
}

// ---------------------------------------------------------------------------
// Reflection runner
// ---------------------------------------------------------------------------

export interface ReflectionContext {
	model: Model<string>;
	mentalMapRepo: MentalMapRepository;
	conversationRepo: ConversationRepository;
}

/**
 * Run a reflection pass at the end of a session.
 *
 * Produces Mental Map patches and a narrative summary that replaces old turns
 * in the stored history, bounding context growth across sessions.
 *
 * Sprint 9: not yet implemented — currently a no-op.
 * The reflection integration test (tests/reflection.integration.test.ts) will
 * fail on its MongoDB assertions until this is filled in.
 */
export async function runReflection(
	_agentId: string,
	_missionId: string,
	_sessionMessages: Message[],
	_ctx: ReflectionContext,
): Promise<void> {
	// TODO Sprint 9: implement per ADR-0009 § 2–3.
}
