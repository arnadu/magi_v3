import {
	createMongoAgentStatsRepository,
	StatsCollector,
} from "../agent-stats.js";
import { createMongoConversationRepository } from "../conversation-repository.js";
import { createMongoLlmCallLogRepository } from "../llm-call-log.js";
import { createMongoMailboxRepository } from "../mailbox.js";
import { createMongoMissionConfigRepository } from "../mission-config.js";
import { createMongoObjectivesRepository } from "../objectives/repository.js";
import type { BootContext } from "./context.js";

export function constructRepositories(
	ctx: Pick<BootContext, "db" | "missionId">,
): Pick<
	BootContext,
	| "mailboxRepo"
	| "conversationRepo"
	| "llmCallLog"
	| "statsCollector"
	| "missionConfigRepo"
	| "objectivesRepo"
> {
	return {
		mailboxRepo: createMongoMailboxRepository(ctx.db, ctx.missionId),
		conversationRepo: createMongoConversationRepository(ctx.db),
		llmCallLog: createMongoLlmCallLogRepository(ctx.db),
		statsCollector: new StatsCollector(createMongoAgentStatsRepository(ctx.db)),
		missionConfigRepo: createMongoMissionConfigRepository(ctx.db),
		objectivesRepo: createMongoObjectivesRepository(ctx.db),
	};
}
