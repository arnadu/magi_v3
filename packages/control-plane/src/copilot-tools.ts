/**
 * Copilot elevated tools — Category B tools that run in the main control-plane
 * process with full MongoDB and Fly Machines access.
 *
 * B1: Read-only tools (ListMissions, GetMissionStatus, ReadMissionMailbox,
 *     ReadMissionLog, ReadMissionFile, ListSchedule, ListTemplates, GetTemplate)
 *
 * B2: Mutating tools via ProposeAction — operator must confirm before execution.
 *     The tool pushes a `copilot-action` SSE event and returns immediately.
 *     Execution happens in copilot-router.ts when the operator confirms.
 *
 * B3: GitHub Issues tools (ListIssues, CreateIssue, CloseIssue, AddIssueComment) —
 *     direct GitHub REST API calls using GH_TOKEN. No operator confirmation required;
 *     GitHub issues are low-risk, fully reversible actions.
 *
 * B4: Objectives tools (ReviewObjectives, AssessKpi, SaveObjectiveTree) — direct
 *     MongoDB writes via the same ObjectivesRepository the in-mission copilot's
 *     EditObjectiveTree/AssessKpi use (ADR-0019), scoped by {missionId, userId}.
 *     No operator confirmation required — same trust tier as B3: reversible,
 *     scoped to the copilot's own data (not an external system or another
 *     agent's state).
 *
 * B5: EditDraftConfig — direct write to a draft mission's config (mission-prep).
 *     No operator confirmation required: unlike a live mission, a draft has no
 *     running agent to collide with and no spend at risk, so an errant edit can
 *     only leave the stored doc in a state the operator notices before Launch.
 *     Launch itself (the actual cost-incurring, state-changing step) stays a B2
 *     ProposeAction (`launch_draft`), same confirmation tier as `launch_mission`.
 */
import type { MagiTool } from "@magi/agent-runtime-worker";
import type { Db } from "mongodb";
import { createGithubTools } from "./copilot-github-tools.js";
import { createObjectiveTools } from "./copilot-objective-tools.js";
import { createProposeTools } from "./copilot-propose-tool.js";
import { createReadTools } from "./copilot-read-tools.js";
import type { PendingActionsStore } from "./pending-actions.js";

// Pending actions live in pending-actions.ts (Mongo-backed); re-exported so
// existing importers keep one path.
export type { PendingAction, PendingActionsStore } from "./pending-actions.js";

/**
 * Build all Category B elevated tools for the copilot.
 *
 * @param db            MongoDB database (full access).
 * @param pushEvent     Push an SSE event to the copilot chat channel.
 * @param pending       Shared store for proposed-but-unconfirmed actions.
 */
export function createCopilotTools(
	db: Db,
	pushEvent: (type: string, data: unknown) => void,
	pending: PendingActionsStore,
	userId: string,
): MagiTool[] {
	const deps = { db, pushEvent, pending, userId };
	const read = createReadTools(deps);
	const objectives = createObjectiveTools(deps);
	const github = createGithubTools(deps);
	return [
		read.listMissions,
		read.getMissionStatus,
		read.readMissionMailbox,
		read.readMissionLog,
		read.readMissionFile,
		objectives.reviewObjectives,
		objectives.assessKpi,
		objectives.saveObjectiveTree,
		objectives.editDraftConfig,
		read.listSchedule,
		read.listTemplates,
		read.getTemplate,
		createProposeTools(deps).proposeAction,
		github.listIssues,
		github.createIssue,
		github.closeIssue,
		github.addIssueComment,
	];
}
