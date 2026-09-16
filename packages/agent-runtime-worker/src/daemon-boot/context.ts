import type { TeamConfig } from "@magi/agent-config";
import type { Model } from "@mariozechner/pi-ai";
import type { Db, MongoClient } from "mongodb";
import type { StatsCollector } from "../agent-stats.js";
import type { AnomalyRecorder } from "../anomaly.js";
import type { ConversationRepository } from "../conversation-repository.js";
import type { LlmCallLogRepository } from "../llm-call-log.js";
import type { MailboxRepository } from "../mailbox.js";
import type { MissionConfigRepository } from "../mission-config.js";
import type { MonitorServer } from "../monitor-server.js";
import type { ObjectivesRepository } from "../objectives/repository.js";
import type { ToolApiServer } from "../tool-api-server.js";
import type { MagiTool } from "../tools.js";
import type { UsageAccumulator } from "../usage.js";
import type { WorkspaceGit } from "../workspace-git.js";
import type { WorkspaceManager } from "../workspace-manager.js";

/**
 * Progressively-widened boot state, threaded by value through daemon.ts's
 * main(). Each extracted phase is typed via Pick<BootContext, ...> on its
 * input and output — an at-a-glance, enforced list of exactly what it reads
 * and produces — and main() merges each phase's return into this object via
 * Object.assign. Grows one field group per phase as main() is decomposed
 * (Sprint 28c, issue #33).
 *
 * A field appearing here does not imply its producing phase has been
 * extracted yet — during the transition, some fields (e.g. db, missionId)
 * are still assigned directly by still-inline code in main() rather than by
 * a Pick<>-typed phase function. The type only declares the eventual shape.
 */
export interface BootContext {
	repoRoot: string;
	mongoUri: string;
	client: MongoClient;
	db: Db;
	missionId: string;
	mailboxRepo: MailboxRepository;
	conversationRepo: ConversationRepository;
	llmCallLog: LlmCallLogRepository;
	statsCollector: StatsCollector;
	missionConfigRepo: MissionConfigRepository;
	objectivesRepo: ObjectivesRepository;
	anomalyRecorder: AnomalyRecorder;
	workdir: string;
	teamDir: string;
	teamConfig: TeamConfig;
	workspaceManager: WorkspaceManager;
	modelId: string;
	model: Model<string>;
	visionModel: Model<string>;
	ac: AbortController;
	signal: AbortSignal;
	pidFile: string;
	usageAccumulator: UsageAccumulator;
	maxCostUsd: number | null;
	monitorPort: number;
	toolPort: number;
	sharedDir: string;
	workspaceGit: WorkspaceGit;
	monitor: MonitorServer;
	toolApiServer: ToolApiServer;
	stopJobRunner: () => void;
	waitForMail: () => Promise<void>;
	missionCopilotTools: MagiTool[] | undefined;
}
