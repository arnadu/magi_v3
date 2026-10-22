/**
 * BrowseWeb's browser session: one Stagehand instance per agent turn (so
 * cookies, auth and history carry across the turn's BrowseWeb calls),
 * created lazily on first use and torn down by close(). Every request the
 * browser makes goes through the egress-filtering proxy (CR-03 / F-002).
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import type { LogLine, V3 as Stagehand } from "@browserbasehq/stagehand";
import type { Model } from "@mariozechner/pi-ai";
import { appendFileInside, mkdirInside } from "../safe-path.js";
import {
	createEgressFilterProxy,
	type EgressProxyHandle,
} from "./browse-web-egress-proxy.js";

export type StagehandModel =
	| string
	| { modelName: string; apiKey: string; baseURL: string };

/**
 * Map the vision model to a Stagehand model config: Anthropic as
 * "anthropic/<id>" (reads ANTHROPIC_API_KEY), OpenRouter through its
 * OpenAI-compatible endpoint (no Anthropic key needed). Anything else fails
 * at construction time.
 */
export function stagehandModelFor(model: Model<string>): StagehandModel {
	if (model.provider === "anthropic") return `anthropic/${model.id}`;
	if (model.provider === "openrouter") {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error(
				`OPENROUTER_API_KEY is required when VISION_MODEL is an OpenRouter model (model: "${model.id}")`,
			);
		}
		return {
			modelName: model.id,
			apiKey,
			baseURL: "https://openrouter.ai/api/v1",
		};
	}
	throw new Error(
		`BrowseWeb does not support vision model provider "${model.provider}" (model: "${model.id}"). ` +
			`Supported providers: anthropic, openrouter.`,
	);
}

/** Per-session NDJSON trace of every Stagehand log line, for debugging. */
export class SessionLog {
	readonly sessionId = new Date().toISOString().replace(/[:.]/g, "-");
	readonly logsDir: string;
	readonly file: string;

	// shared/logs is agent-writable: every daemon write there is contained and
	// never follows a planted link (BND-5).
	constructor(readonly sharedDir: string) {
		this.logsDir = join(sharedDir, "logs");
		this.file = join(this.logsDir, `browse-web-${this.sessionId}.ndjson`);
	}

	write(entry: Record<string, unknown>): void {
		try {
			appendFileInside(
				this.sharedDir,
				`logs/browse-web-${this.sessionId}.ndjson`,
				`${JSON.stringify(entry)}\n`,
			);
		} catch (e) {
			// Non-fatal: browser automation continues, but surface the failure so
			// operators know the session log is incomplete.
			console.error(
				`[browse-web] Session log write failed: ${(e as Error).message}`,
			);
		}
	}

	onStagehandLog = (line: LogLine): void => {
		this.write({
			ts: line.timestamp ?? new Date().toISOString(),
			level: line.level,
			category: line.category,
			message: line.message,
			...(line.id ? { id: line.id } : {}),
		});
		// Errors and agent actions also go to stdout for live visibility.
		if (line.level === 0 || line.category === "agent") {
			console.log(`[stagehand] ${line.category ?? ""} ${line.message}`);
		}
	};
}

export class BrowserSession {
	private stagehand: Stagehand | null = null;
	private initPromise: Promise<Stagehand> | null = null;
	private profileDir: string | null = null;
	private egressProxy: EgressProxyHandle | null = null;

	constructor(
		private readonly model: StagehandModel,
		private readonly chromiumPath: string,
		private readonly allowedHosts: string[],
		private readonly log: SessionLog,
	) {}

	get(): Promise<Stagehand> {
		if (this.stagehand) return Promise.resolve(this.stagehand);
		this.initPromise ??= this.start();
		return this.initPromise;
	}

	private async start(): Promise<Stagehand> {
		// Imported lazily so contexts without Playwright/Chromium (the control
		// plane) never resolve the module.
		const { V3: StagehandClass } = await import("@browserbasehq/stagehand");
		// The logs dir is created on first use, so agents that never browse do
		// not need write access to sharedDir.
		// An absolute Linux path: on WSL2 chrome-launcher would otherwise turn it
		// into a UNC path that Playwright creates as a literal directory name.
		// Exclusive: a directory or link already at this name was planted.
		const dir = mkdirInside(
			this.log.sharedDir,
			`logs/profile-${this.log.sessionId}`,
		);
		this.profileDir = dir;
		// Stagehand V3's Page has no route(), so the checks in execute() cover
		// only page.goto(); once agent() clicks, redirects or opens popups,
		// only this proxy sees where the browser goes.
		const proxy = await createEgressFilterProxy(this.allowedHosts);
		this.egressProxy = proxy;
		const sh = new StagehandClass({
			env: "LOCAL",
			model: this.model,
			localBrowserLaunchOptions: {
				executablePath: this.chromiumPath,
				headless: true,
				userDataDir: dir,
				// Chromium implicitly bypasses the proxy for loopback destinations;
				// "<-loopback>" removes that exemption so 127.0.0.0/8 is filtered
				// like everything else (verified by the CR-03 regression test).
				proxy: { server: proxy.url, bypass: "<-loopback>" },
			},
			verbose: 2, // capture all log lines (written to session log file)
			disablePino: true,
			logger: this.log.onStagehandLog,
		});
		try {
			await sh.init();
		} catch (e) {
			// Cleared so the next call retries rather than re-throwing this forever.
			this.initPromise = null;
			await this.egressProxy?.close().catch(() => {});
			this.egressProxy = null;
			throw e;
		}
		this.stagehand = sh;
		return sh;
	}

	async close(): Promise<void> {
		if (this.stagehand) {
			// Bounded: Stagehand's close() can take unpredictably long after a
			// busy session, and agent-runner awaits this in a finally block. The
			// proxy below drops its connections either way.
			await Promise.race([
				this.stagehand.close().catch(() => {}),
				new Promise((res) => setTimeout(res, 15_000)),
			]);
			this.stagehand = null;
			this.initPromise = null;
		}
		if (this.profileDir) {
			try {
				rmSync(this.profileDir, { recursive: true, force: true });
			} catch {
				// Non-fatal: a stale profile dir is disk waste, not a correctness issue.
			}
			this.profileDir = null;
		}
		if (this.egressProxy) {
			await this.egressProxy.close().catch(() => {});
			this.egressProxy = null;
		}
	}
}
