/**
 * Tell the copilot what became of an action it proposed. The operator
 * confirms or dismisses a card in the cockpit; without this message the
 * copilot never learns the outcome (the result went only to the browser), so
 * it could not continue a multi-step workflow or fix a failed action until the
 * operator asked. The message lands in the copilot's own mailbox, which wakes
 * it like any other message.
 */

import type { Db } from "mongodb";
import { postMailbox } from "./mailbox-writer.js";
import type { PendingAction } from "./pending-actions.js";

export type ActionOutcome =
	| { kind: "executed"; result: string }
	| { kind: "failed"; error: string }
	| { kind: "dismissed" };

const NEXT_STEP: Record<ActionOutcome["kind"], string> = {
	executed:
		"Continue the workflow this action was part of, and tell the operator what happens next.",
	failed:
		"Fix the cause (read the error), then propose a corrected action. Tell the operator what you changed.",
	dismissed:
		"The operator declined it. Don't re-propose it unchanged; ask what they want instead if it isn't clear.",
};

export function actionOutcomeMessage(
	action: Pick<PendingAction, "id" | "type" | "label">,
	outcome: ActionOutcome,
): { subject: string; body: string } {
	const verb = {
		executed: "executed",
		failed: "FAILED",
		dismissed: "dismissed by the operator",
	}[outcome.kind];
	const detail =
		outcome.kind === "executed"
			? `Result: ${outcome.result}`
			: outcome.kind === "failed"
				? `Error: ${outcome.error}`
				: "";
	return {
		subject: `Action ${verb}: ${action.label}`.slice(0, 200),
		body: [
			`Your proposed action ${action.id} (${action.type}) was ${verb}.`,
			detail,
			NEXT_STEP[outcome.kind],
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

export async function reportActionOutcome(
	db: Db,
	action: Pick<PendingAction, "id" | "type" | "label" | "userId">,
	outcome: ActionOutcome,
): Promise<void> {
	const { subject, body } = actionOutcomeMessage(action, outcome);
	try {
		await postMailbox(db, {
			missionId: `copilot-${action.userId}`,
			from: "system",
			to: ["copilot"],
			subject,
			body,
		});
	} catch (e) {
		console.error(
			`[copilot] failed to report an action outcome to the copilot { actionId: "${action.id}", outcome: "${outcome.kind}", error: "${(e as Error).message}" } — the copilot will not know the outcome until the operator tells it`,
		);
	}
}
