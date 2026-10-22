/**
 * The concurrent dispatcher behind runOrchestrationLoop: start every agent
 * that has unread mail and is not running, paused, inactive or cooling down
 * after an LLM error, each as a fire-and-forget run with its own wall-clock
 * timeout.
 */

import type { AgentConfig } from "@magi/agent-config";
import type { Message } from "@mariozechner/pi-ai";
import { runAgent } from "./agent-runner.js";
import type { MailboxMessage } from "./mailbox.js";
import type { OrchestratorConfig } from "./orchestrator.js";
import {
	postUserLine,
	promptUser,
	type SharedAgentContext,
	type UserInput,
} from "./orchestrator-setup.js";
import { createErrorCooldown } from "./retry-backoff.js";
import type { AgentIdentity } from "./workspace-manager.js";

// Per-dispatch wall-clock timeout: abort a hung agent run after this many
// seconds. Override with MAX_AGENT_RUN_SECONDS env var. Default 4 hours.
const MAX_AGENT_RUN_SECONDS =
	Number(process.env.MAX_AGENT_RUN_SECONDS) || 4 * 3600;

export interface DispatcherDeps {
	config: OrchestratorConfig;
	signal?: AbortSignal;
	maxRuns: number;
	identities: Map<string, AgentIdentity>;
	agentCtx: SharedAgentContext;
	input: UserInput;
	leadAgentId: string;
}

const DISPATCH_RETRY_MS = 30_000;

export class Dispatcher {
	/** Running agents and their completion promises. */
	readonly active = new Map<string, AbortController>();
	readonly activePromises = new Map<string, Promise<void>>();
	private runs = 0;
	// Per-agent LLM-error cooldown (#55); a timer re-dispatches when it ends.
	private readonly cooldown;
	// checkIdle() can call dispatchReady() while an earlier call is parked in
	// a step/budget gate for a later agent; two independent passes would ask
	// that gate twice for one dispatch (caught by TC-4's "exactly 2 step
	// calls"). A call that arrives mid-pass is coalesced into one more pass.
	private dispatchInFlight = false;
	private dispatchAgainRequested = false;
	private retryTimer: NodeJS.Timeout | undefined;

	constructor(private readonly deps: DispatcherDeps) {
		this.cooldown = createErrorCooldown(deps.config, () =>
			this.kick("cooldown end", () => this.dispatchReady()),
		);
	}

	totalRuns(): number {
		return this.runs;
	}

	dispose(): void {
		this.cooldown.dispose();
		clearTimeout(this.retryTimer);
	}

	/**
	 * Run a dispatch pass nobody awaits (a timer, a run's completion). A
	 * failure — typically a Mongo blip reading the mailbox — is logged and
	 * retried later; left unhandled it would become an unhandledRejection,
	 * which shuts the whole daemon down with a clean exit that Fly's
	 * on-failure restart policy never restarts (RES-3).
	 */
	private kick(origin: string, pass: () => Promise<void>): void {
		pass().catch((e) => {
			if (this.deps.signal?.aborted) return;
			console.error(
				`[orchestrator] dispatch pass after ${origin} failed: ${(e as Error).message} — retrying in ${DISPATCH_RETRY_MS / 1000}s; unread mail waits until then`,
			);
			this.retryTimer ??= setTimeout(() => {
				this.retryTimer = undefined;
				this.kick("a failed pass", () => this.checkIdle());
			}, DISPATCH_RETRY_MS);
			this.retryTimer.unref();
		});
	}

	async dispatchReady(): Promise<void> {
		if (this.dispatchInFlight) {
			this.dispatchAgainRequested = true;
			return;
		}
		this.dispatchInFlight = true;
		try {
			do {
				this.dispatchAgainRequested = false;
				await this.dispatchOnePass();
			} while (this.dispatchAgainRequested);
		} finally {
			this.dispatchInFlight = false;
		}
	}

	async anyAgentHasUnreadMail(): Promise<boolean> {
		for (const agent of this.deps.config.teamConfig.agents) {
			if (await this.deps.config.mailboxRepo.hasUnread(agent.id)) return true;
		}
		return false;
	}

	private get missionId(): string {
		return this.deps.config.teamConfig.mission.id;
	}

	private postLine(line: string): Promise<boolean> {
		const { config, leadAgentId } = this.deps;
		return postUserLine(
			config.mailboxRepo,
			this.missionId,
			leadAgentId,
			line,
			config.workdir,
		);
	}

	private async flushInputBuffer(): Promise<void> {
		const { buffer } = this.deps.input;
		while (buffer.length > 0) {
			await this.postLine(buffer.shift() as string);
		}
	}

	/**
	 * Called when any agent's turn ends. In daemon mode the main loop only
	 * re-dispatches on a *new* mailbox insert, so mail that arrived during a
	 * turn would otherwise wait for an unrelated later insert (#48: a message
	 * sat ~16 hours). dispatchReady() skips agents with no mail or already
	 * running, so calling it whenever unread mail exists is always safe.
	 */
	private async checkIdle(): Promise<void> {
		if (this.active.size > 0 || this.deps.signal?.aborted) return;
		if (await this.anyAgentHasUnreadMail()) {
			await this.dispatchReady();
		} else {
			this.deps.config.onIdle?.();
		}
	}

	private skips(agent: AgentConfig): boolean {
		return (
			this.active.has(agent.id) ||
			this.deps.config.isAgentPaused?.(agent.id) === true ||
			agent.active === false ||
			this.cooldown.active(agent.id)
		);
	}

	/**
	 * The step and budget gates. Step mode serialises dispatch, one agent per
	 * permit (or a TTY prompt, which may carry a message for the lead); the
	 * budget gate blocks while the spending cap is reached. False once aborted.
	 */
	private async passGates(agent: AgentConfig): Promise<boolean> {
		const { config, signal, input } = this.deps;
		if (config.waitForStep) {
			await config.waitForStep();
			if (signal?.aborted) return false;
		} else if (config.step && input.rl) {
			const line = await promptUser(
				input.rl,
				`[step] About to run ${agent.name ?? agent.id}. Press Enter or type a message: `,
			);
			if (line) await this.postLine(line);
			if (signal?.aborted) return false;
		}
		if (config.waitForBudget) {
			await config.waitForBudget();
			if (signal?.aborted) return false;
		}
		return true;
	}

	private async dispatchOnePass(): Promise<void> {
		const { config, signal, maxRuns } = this.deps;
		const { mailboxRepo } = config;
		if (signal?.aborted) return;
		await this.flushInputBuffer();
		for (const agent of config.teamConfig.agents) {
			if (this.skips(agent)) continue;
			if (this.runs >= maxRuns) break;
			// No permits are taken for an agent with nothing to read.
			if (!(await mailboxRepo.hasUnread(agent.id))) continue;
			if (!(await this.passGates(agent))) return;
			// Re-check after yielding at the gates: the mail may have been read, or a
			// concurrent pass may have started the agent.
			if (this.active.has(agent.id)) continue;
			if (!(await mailboxRepo.hasUnread(agent.id))) continue;
			const messages = await mailboxRepo.listUnread(agent.id);
			if (messages.length === 0) continue;
			await mailboxRepo.markRead(
				messages.map((m) => m.id),
				agent.id,
			);
			this.startRun(agent, messages);
		}
	}

	/** Start one agent's turn without awaiting it. */
	private startRun(agent: AgentConfig, messages: MailboxMessage[]): void {
		const { config, signal } = this.deps;
		const agentId = agent.id;
		const identity = this.deps.identities.get(agentId);
		if (!identity)
			throw new Error(`No workspace identity for agent "${agentId}"`);
		this.runs++;
		const ctrl = new AbortController();
		const onParentAbort = () => ctrl.abort();
		signal?.addEventListener("abort", onParentAbort, { once: true });
		const runTimeoutId = this.armRunTimeout(agentId, ctrl);
		this.active.set(agentId, ctrl);
		config.onAgentStart?.(
			agentId,
			[...this.active.keys()].filter((id) => id !== agentId),
		);
		console.log(
			`\n[orchestrator] Running ${agent.name ?? agentId}` +
				` (${identity.linuxUser}) (${messages.length} message(s))`,
		);
		const promise = runAgent(
			agentId,
			messages,
			{
				...this.deps.agentCtx,
				identity,
				anomalyRecorder: config.anomalyRecorder,
				additionalTools: config.getAdditionalTools?.(agentId),
				onMessage: async (msg: Message) => {
					this.cooldown.note(agentId, msg);
					await config.onAgentMessage?.(agentId, msg);
				},
			},
			ctrl.signal,
		)
			.catch((err) => {
				if (!ctrl.signal.aborted)
					this.reportCrash(agentId, (err as Error).message);
			})
			.finally(() => {
				clearTimeout(runTimeoutId);
				signal?.removeEventListener("abort", onParentAbort);
				this.active.delete(agentId);
				this.activePromises.delete(agentId);
				config.onAgentDone?.(agentId);
				this.kick(`${agentId}'s run`, () => this.checkIdle());
			});
		this.activePromises.set(agentId, promise);
	}

	/**
	 * Abort a run that exceeds the wall-clock limit (a hung LLM call or a
	 * pathological tool loop would otherwise freeze the orchestrator).
	 */
	private armRunTimeout(
		agentId: string,
		ctrl: AbortController,
	): ReturnType<typeof setTimeout> {
		const { config } = this.deps;
		const maxRunMs =
			(config.maxAgentRunSeconds ?? MAX_AGENT_RUN_SECONDS) * 1000;
		return setTimeout(() => {
			if (ctrl.signal.aborted) return;
			console.warn(
				`[orchestrator] ${agentId} exceeded ${maxRunMs / 1000}s wall-clock limit — aborting`,
			);
			ctrl.abort();
			config.anomalyRecorder
				?.record({
					missionId: this.missionId,
					category: "agent-timeout",
					severity: "hard",
					agentId,
					message:
						`Agent "${agentId}" exceeded the ${maxRunMs / 1000}s wall-clock ` +
						`limit and was aborted. Investigate with ReadAgentSessionDetail ` +
						`before concluding what happened.`,
				})
				.catch((e: Error) =>
					console.error(
						`[orchestrator] failed to record agent-timeout anomaly: ${e.message}`,
					),
				);
		}, maxRunMs);
	}

	private reportCrash(agentId: string, errMsg: string): void {
		const { config } = this.deps;
		console.error(`[orchestrator] ${agentId} error: ${errMsg}`);
		config.onAgentError?.(agentId, errMsg);
		config.anomalyRecorder
			?.record({
				missionId: this.missionId,
				category: "agent-crash",
				severity: "hard",
				agentId,
				message: `Agent "${agentId}" encountered an error: ${errMsg}`,
			})
			.catch((e: Error) =>
				console.error(
					`[orchestrator] failed to record agent-crash anomaly: ${e.message}`,
				),
			);
	}
}
