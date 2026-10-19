import { randomUUID } from "node:crypto";
import type { MagiTool } from "@magi/agent-runtime-worker";
import { Type } from "@sinclair/typebox";
import {
	ActionValidationError,
	describeActions,
	parseActionPayload,
} from "./copilot-actions.js";
import { proposeGithubIssue } from "./copilot-github-tools.js";
import { type CopilotToolDeps, err, ok } from "./copilot-tool-deps.js";
import { GITHUB_ISSUE_ACTION } from "./github-issues.js";
import type { PendingAction } from "./pending-actions.js";

// ─── B2: mutating via ProposeAction ───────────────────────────────────────
function proposeActionTool(deps: CopilotToolDeps): MagiTool {
	const { pushEvent, pending, userId } = deps;
	return {
		name: "ProposeAction",
		description:
			"Propose a mutating action for operator confirmation. " +
			"The action is shown to the operator in the chat UI as a confirmation card with its " +
			"full validated payload under a server-computed label. This tool returns immediately — " +
			"execution happens when the operator confirms. The payload is validated strictly: a " +
			"missing, mistyped or unknown field is rejected here (nothing is proposed), so pass " +
			"exactly the fields listed.\n\n" +
			`Action types and payloads:\n${describeActions()}`,
		parameters: Type.Object({
			type: Type.String({ description: "Action type (see description)" }),
			payload: Type.Unknown({
				description:
					"Action-specific parameters. Pass as a JSON object, not a string.",
			}),
			label: Type.Optional(
				Type.String({
					description:
						"Ignored — the card's label is computed from the validated payload.",
				}),
			),
		}),
		async execute(_id, args) {
			let parsed: ReturnType<typeof parseActionPayload>;
			try {
				parsed = parseActionPayload(args.type, args.payload);
			} catch (e) {
				if (e instanceof ActionValidationError) return err(e.message);
				throw e;
			}
			if (parsed.type === GITHUB_ISSUE_ACTION) {
				return proposeGithubIssue(deps, parsed.payload);
			}
			const action: PendingAction = {
				id: randomUUID(),
				userId,
				type: parsed.type,
				label: parsed.label,
				payload: parsed.payload,
				createdAt: new Date(),
			};
			await pending.add(action);
			pushEvent("copilot-action", {
				id: action.id,
				type: action.type,
				label: action.label,
				payload: action.payload,
			});
			return ok(
				`Action proposed: "${action.label}" (id: ${action.id}).\n` +
					"Waiting for operator confirmation. You can continue your response — " +
					"execution will happen when the operator confirms.",
			);
		},
	};
}

export function createProposeTools(deps: CopilotToolDeps) {
	return {
		proposeAction: proposeActionTool(deps),
	};
}
