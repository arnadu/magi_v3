import { storedCollection } from "@magi/agent-config";
import { Type } from "@sinclair/typebox";
import type { MissionCopilotToolDeps } from "./mission-copilot-tool-deps.js";
import { err, ok, okJson } from "./mission-copilot-tool-result.js";
import type { MagiTool } from "./tools.js";

// ─── Family D — Resource Governance ──────────────────────────────────────
function readMissionCostSeriesTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadMissionCostSeries",
		description:
			"Per-turn cost series for the mission, optionally filtered to one agent — the same data backing the cockpit's Trace chart. Also the spend side of the alignment-review cost-vs-progress cross-check. Defaults to the most recent 100 turns across the mission, not its entire lifetime.",
		parameters: Type.Object({
			agentId: Type.Optional(
				Type.String({ description: "Filter to one agent" }),
			),
			limit: Type.Optional(
				Type.Number({ description: "Max turns to return (default 100)" }),
			),
		}),
		async execute(_id, args) {
			const agentId = args.agentId as string | undefined;
			const limit = Math.min((args.limit as number | undefined) ?? 100, 500);
			const filter: Record<string, unknown> = {
				missionId,
				completedAt: { $exists: true },
			};
			if (agentId) filter.agentId = agentId;
			const docs = await storedCollection(db, "agentTurnStats")
				.find(filter, {
					projection: {
						agentId: 1,
						turnNumber: 1,
						completedAt: 1,
						costUsd: 1,
						_id: 0,
					},
				})
				.sort({ completedAt: -1 })
				.limit(limit)
				.toArray();
			return okJson(docs.reverse());
		},
	};
}

function readMissionLifetimeStatsTool(deps: MissionCopilotToolDeps): MagiTool {
	const { db, missionId } = deps;
	return {
		name: "ReadMissionLifetimeStats",
		description: "Lifetime cost/call/turn totals per agent.",
		parameters: Type.Object({}),
		async execute() {
			const docs = await storedCollection(db, "missionStats")
				.find(
					{ missionId },
					{
						projection: {
							agentId: 1,
							lifetimeCostUsd: 1,
							lifetimeLlmCallCount: 1,
							lifetimeTurnCount: 1,
							_id: 0,
						},
					},
				)
				.toArray();
			return okJson(docs);
		},
	};
}

function setMissionSpendCapTool(deps: MissionCopilotToolDeps): MagiTool {
	const { monitorPost, auditPost } = deps;
	return {
		name: "SetMissionSpendCap",
		description:
			"Set the mission-wide hard spending cap — pauses the entire mission if exceeded (distinct from an objective's own budgetUsd, which is soft/informational and set with EditObjectiveTree). Raise only when justified by the mission's objectives. Posts an audit message to the user's mailbox — this is self-referential: raising it also funds the copilot's own further calls.",
		parameters: Type.Object({
			capUsd: Type.Number({ description: "New absolute spending cap in USD" }),
		}),
		async execute(_id, args) {
			const capUsd = args.capUsd as number;
			if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 100_000) {
				return err(
					`SetMissionSpendCap: capUsd must be a positive finite amount in USD (got ${String(capUsd)})`,
				);
			}
			const result = await monitorPost("/set-budget", { capUsd });
			if (!result.ok) return err(`Failed to set budget: ${result.body}`);
			await auditPost(
				"Mission spend cap changed",
				`I set the mission's spending cap to $${capUsd.toFixed(2)}.`,
			);
			return ok(result.body);
		},
	};
}

export function createResourceTools(deps: MissionCopilotToolDeps) {
	return {
		readMissionCostSeries: readMissionCostSeriesTool(deps),
		readMissionLifetimeStats: readMissionLifetimeStatsTool(deps),
		setMissionSpendCap: setMissionSpendCapTool(deps),
	};
}
