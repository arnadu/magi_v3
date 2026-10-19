/**
 * Mission copilot elevated tools (ADR-0016, Families A-F; Family G lands with
 * Phase 5's GitHub proxy — see Sequencing).
 *
 * Every tool's LLM-facing schema takes zero mission-identifying parameters —
 * missionId is always closure-supplied here, never something the model can
 * set. This is the structural guarantee that protects other missions: there
 * is no cross-mission code path to get wrong, not a parameter to check.
 *
 * Two backends, chosen per tool by what the operation actually needs:
 *   - Direct Mongo / in-process (most tools): a simple query, or a call into
 *     an already-exported pure function (e.g. loadObjectivesStore). Cheaper
 *     and avoids a network hop for logic this process already owns outright.
 *   - HTTP through the mission's own MonitorServer (loopback): reserved for
 *     genuinely encapsulated logic (path-traversal-safe file serving, git
 *     provenance) or in-memory state that only the *running* MonitorServer
 *     instance holds (pause/resume, the budget cap) — reusing those code
 *     paths instead of duplicating them keeps a single source of truth and
 *     reuses the same audit/SSE side effects the dashboard's own buttons
 *     trigger. Every call, GET included, sends x-monitor-token — the monitor
 *     is reachable from other machines in the app over 6PN, so nothing on it
 *     is unauthenticated.
 *
 * Trust-boundary marking: every read that returns free text a teammate wrote
 * (or that passed through a teammate) is wrapped — this is not limited to
 * "Family C" tools, it's about the shape of the data. See wrapTrustBoundary.
 *
 * Audit trail: every mutating tool posts a summary to the user's mailbox on
 * the same call. Only SaveMissionConfig has a grace period (next-resume
 * delay); everything else is immediate, with the audit post as the only
 * check (F-026).
 */

import { createConfigTools } from "./mission-copilot-config-tools.js";
import { createDiagnosticsTools } from "./mission-copilot-diagnostics-tools.js";
import { createGithubTools } from "./mission-copilot-github-tools.js";
import { createInterventionTools } from "./mission-copilot-intervention-tools.js";
import { createMonitoringTools } from "./mission-copilot-monitoring-tools.js";
import { createObjectivesTools } from "./mission-copilot-objectives-tools.js";
import { createResourceTools } from "./mission-copilot-resource-tools.js";
import { createScheduleTools } from "./mission-copilot-schedule-tools.js";
import {
	createToolDeps,
	type MissionCopilotToolsConfig,
} from "./mission-copilot-tool-deps.js";
import { createResourceUpgradeTools } from "./resource-upgrade-tool.js";
import type { MagiTool } from "./tools.js";

export type { MissionCopilotToolsConfig };

/** Every mission-copilot tool, families A–G in their documented order. */
export function createMissionCopilotTools(
	config: MissionCopilotToolsConfig,
): MagiTool[] {
	const deps = createToolDeps(config);
	const { missionId, sharedDir, db, auditPost, controlPlaneUrl, monitorToken } =
		deps;
	const a = createConfigTools(deps);
	const b = createObjectivesTools(deps);
	const c = createMonitoringTools(deps);
	const d = createResourceTools(deps);
	const e = createInterventionTools(deps);
	const f = createDiagnosticsTools(deps);
	const g = createGithubTools(deps);
	const schedule = createScheduleTools({ db, missionId, sharedDir, auditPost });
	return [
		a.readMissionConfig,
		a.saveMissionConfig,
		b.readMissionObjectives,
		b.editObjectiveTree,
		c.readAgentMentalMap,
		c.listAgentSessions,
		c.readAgentUsage,
		c.readAgentSessionDetail,
		c.readAgentLlmCall,
		c.readMissionMailboxAll,
		c.readMissionInteractions,
		c.searchMissionHistory,
		d.readMissionCostSeries,
		d.readMissionLifetimeStats,
		d.setMissionSpendCap,
		e.pauseAgent,
		e.resumeAgent,
		schedule.createScheduledMessage,
		schedule.cancelScheduledMessage,
		e.cancelBackgroundJobTool,
		e.restartBackgroundJob,
		f.readMissionLog,
		f.readFileHistory,
		f.readSharedFile,
		f.readAgentWorkdirFile,
		f.listBackgroundJobs,
		schedule.listScheduledMessages,
		g.listGithubIssues,
		g.reportGithubIssue,
		...createResourceUpgradeTools({ missionId, controlPlaneUrl, monitorToken }),
	];
}
