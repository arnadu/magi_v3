/**
 * What runOrchestrationLoop needs before its first dispatch: provisioned
 * workspaces with verified isolation, the shared-workspace git queue, the
 * terminal input (TTY only), and the per-agent run context.
 */

import * as readline from "node:readline";
import type { AgentRunContext } from "./agent-runner.js";
import { resolveLinuxUsers } from "./linux-user.js";
import type { MailboxMessage, MailboxRepository } from "./mailbox.js";
import type { OrchestratorConfig } from "./orchestrator.js";
import { verifyIsolation } from "./tools.js";
import { processUserInput } from "./user-input.js";
import { WorkspaceGit } from "./workspace-git.js";
import type { AgentIdentity } from "./workspace-manager.js";

export interface ProvisionedTeam {
	identities: Map<string, AgentIdentity>;
	workspaceGit: WorkspaceGit;
}

/**
 * Provision every agent's workspace and check the isolation invariant: the
 * platform's secrets must not be visible to a child process (fails fast if
 * sudo is misconfigured). Linux users come from resolveLinuxUsers: agent.id in
 * production, a fail-loud pool-slot mapping in local dev.
 */
export async function provisionTeam(
	config: OrchestratorConfig,
): Promise<ProvisionedTeam> {
	const { teamConfig, workspaceManager } = config;
	const resolvedLinuxUsers = resolveLinuxUsers(teamConfig.agents);
	const agentDefs = teamConfig.agents.map((a) => {
		const linuxUser = resolvedLinuxUsers.get(a.id);
		if (!linuxUser) {
			throw new Error(`No Linux user resolved for agent "${a.id}"`);
		}
		return { id: a.id, linuxUser };
	});
	const identities = workspaceManager.provision(
		teamConfig.mission.id,
		agentDefs,
	);
	console.log(
		`[orchestrator] Workspace provisioned for ${identities.size} agent(s)`,
	);
	config.onWorkspaceReady?.(
		new Map([...identities.entries()].map(([id, ws]) => [id, ws.workdir])),
	);

	const firstIdentity = identities.get(agentDefs[0].id);
	if (!firstIdentity)
		throw new Error("No identity for first agent after provision");
	await verifyIsolation(firstIdentity.linuxUser, firstIdentity.workdir);
	console.log(
		"[orchestrator] Isolation verified — child env does not contain secrets",
	);

	// git-commit-on-sleep: one WorkspaceGit per mission serializes commits
	// across concurrent agents. The daemon passes its own so the monitor's
	// file-edit route shares the same queue.
	const workspaceGit =
		config.workspaceGit ?? new WorkspaceGit(firstIdentity.sharedDir);
	return { identities, workspaceGit };
}

export interface UserInput {
	/** Null unless stdin is a TTY. */
	rl: readline.Interface | null;
	/** Lines typed while agents run, posted to the lead before the next dispatch. */
	buffer: string[];
}

export function openUserInput(): UserInput {
	const buffer: string[] = [];
	if (!process.stdin.isTTY) return { rl: null, buffer };
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false,
	});
	rl.on("line", (line) => {
		if (line.trim()) buffer.push(line.trim());
	});
	// readline intercepts Ctrl+C on stdin; re-raise as a process SIGINT.
	rl.on("SIGINT", () => process.emit("SIGINT"));
	return { rl, buffer };
}

export function promptUser(
	rl: readline.Interface,
	prompt: string,
): Promise<string> {
	return new Promise((resolve) => {
		rl.question(prompt, (answer) => resolve(answer.trim()));
	});
}

/** Turn a line the operator typed into a message to the lead agent; false when it produced nothing to send. */
export async function postUserLine(
	mailboxRepo: MailboxRepository,
	missionId: string,
	leadAgentId: string,
	line: string,
	workdir: string,
): Promise<boolean> {
	const body = await processUserInput(line, workdir);
	if (!body) return false;
	await mailboxRepo.post({
		missionId,
		from: "user",
		to: [leadAgentId],
		subject: "User message",
		body,
	});
	return true;
}

/** The run context shared by every dispatch; each adds its identity, tools and message hook. */
export type SharedAgentContext = Omit<
	AgentRunContext,
	"identity" | "anomalyRecorder" | "additionalTools" | "onMessage"
>;

export function buildAgentContext(
	config: OrchestratorConfig,
	workspaceGit: WorkspaceGit,
): SharedAgentContext {
	return {
		model: config.model,
		visionModel: config.visionModel ?? config.model,
		teamConfig: config.teamConfig,
		mailboxRepo: config.mailboxRepo,
		conversationRepo: config.conversationRepo,
		llmCallLog: config.llmCallLog,
		statsCollector: config.statsCollector,
		missionConfig: config.missionConfig,
		objectivesRepo: config.objectivesRepo,
		onLimitAlert: config.onLimitAlert,
		commitWorkspace: (message: string) => workspaceGit.commit(message),
		allowedHosts: config.allowedHosts,
		onMentalMapUpdate: config.onMentalMapUpdate,
		onUserMessage: (msg: MailboxMessage) => {
			const timestamp = msg.timestamp.toISOString();
			console.log(`\n[→ USER from ${msg.from}] ${msg.subject} (${timestamp})`);
			console.log(msg.body);
			console.log();
			config.onUserMessage?.(msg);
		},
	};
}
