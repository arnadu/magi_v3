/**
 * Sprint 12 — Integration Test: Data Factory end-to-end
 *
 * Scenario:
 *   A single "data-researcher" agent is given a pre-configured data factory
 *   (sources.json written by the test setup) and asked to:
 *     1. Run a data refresh (magi-python3 refresh.py via Bash)
 *     2. Check the catalog and read the latest price data from the CSV
 *     3. Read the news digest produced by the refresh pipeline
 *     4. Report findings to the user
 *
 * The test pre-creates:
 *   - $FACTORY/sources.json   — SPY daily (yfinance, no API key) + one news source
 *   - $FACTORY/news/sp500-news/raw.json  — fixture with two Wikipedia URLs (stable)
 *
 * The refresh.py run:
 *   - Fetches SPY price data via yfinance → catalog.json + series CSV
 *   - Runs process_news.py on the fixture raw.json → digest.json (is_new flags set)
 *   - Skips brief synthesis (MAGI_TOOL_TOKEN not set in Bash subprocess)
 *
 * Assertions:
 *   1. catalog.json written with an SPY entry (status ok or error — network optional)
 *   2. digest.json written for sp500-news (process_news ran on fixture)
 *   3. User received a message with substantive content (> 100 chars)
 *   4. User message mentions market or stock data
 *
 * Requires: ANTHROPIC_API_KEY + MONGODB_URI in .env
 * Requires: magi-python3 wrapper from scripts/setup-dev.sh
 * Network:  yfinance (optional — test passes either way) + Wikipedia fetch
 *
 * Timeout: 5 minutes
 */

import { execSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { beforeAll, describe, expect, it } from "vitest";
import { createMongoConversationRepository } from "../src/conversation-repository.js";
import { createMongoLlmCallLogRepository } from "../src/llm-call-log.js";
import type { MailboxMessage } from "../src/mailbox.js";
import { createMongoMailboxRepository } from "../src/mailbox.js";
import { CLAUDE_HAIKU, CLAUDE_SONNET } from "../src/models.js";
import { connectMongo } from "../src/mongo.js";
import { runOrchestrationLoop } from "../src/orchestrator.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) throw new Error("MONGODB_URI is required for integration tests");

const TEAM_CONFIG_PATH = fileURLToPath(
	new URL("../../../config/teams/data-factory-test.yaml", import.meta.url),
);

/** Fixed output dir — preserved between runs for inspection. Cleaned at test start. */
const OUTPUT_DIR = join(tmpdir(), "magi-data-factory-test");

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * sources.json for the test factory.
 * SPY via yfinance (no API key, network-optional).
 * sp500-news via a "fixture" adapter entry — raw.json is pre-written by the test,
 * so the adapter step is skipped (raw.json already present satisfies refresh.py).
 */
function buildSourcesJson(factoryDir: string): object {
	return {
		series: [
			{
				id: "yfinance/SPY_daily",
				adapter: "yfinance",
				params: { ticker: "SPY" },
				schedule: "daily",
				output: "series/yfinance/SPY_daily.csv",
			},
		],
		news: [
			{
				id: "sp500-news",
				// gdelt requires no API key and is already an adapter in the platform skill.
				// We pre-write raw.json so the actual network call is skipped if gdelt is
				// unavailable — catalog.py refresh skips sources whose raw.json already exists
				// and is newer than the fetch schedule. We use newsapi adapter name here but
				// pre-seed raw.json directly, bypassing the adapter entirely via a mock path.
				// Actually: the test just pre-creates raw.json; process_news.py reads it directly.
				// The adapter is only called if raw.json is absent — see catalog.py logic.
				adapter: "gdelt",
				params: { query: "S&P 500 stock market" },
				schedule: "daily",
				output_dir: "news/sp500-news",
			},
		],
		documents: [],
	};
}

/** Fixture news raw.json — two stable Wikipedia URLs. */
function buildRawJson(): object {
	return {
		fetched_at: new Date().toISOString(),
		items: [
			{
				title: "S&P 500 - Wikipedia",
				url: "https://en.wikipedia.org/wiki/S%26P_500",
				source: "Wikipedia",
				published_at: new Date().toISOString(),
				summary: "The S&P 500 is a stock market index tracking 500 large US companies.",
			},
			{
				title: "Stock market index - Wikipedia",
				url: "https://en.wikipedia.org/wiki/Stock_market_index",
				source: "Wikipedia",
				published_at: new Date().toISOString(),
				summary: "A stock market index measures the value of a section of the stock market.",
			},
		],
	};
}

// ---------------------------------------------------------------------------
// MongoDB dump helpers
// ---------------------------------------------------------------------------

/**
 * Dump conversation messages and LLM call log to files in the output dir.
 *
 * Written files:
 *   $tmpDir/conversation.md   — human-readable transcript (role, content preview)
 *   $tmpDir/mental-map.html   — final mental map HTML snapshot
 *   $tmpDir/llm-calls.json    — full LLM call log (indented JSON)
 *   $tmpDir/mailbox.json      — all mailbox messages (indented JSON)
 */
async function dumpMongoToFiles(
	// biome-ignore lint/suspicious/noExplicitAny: MongoDB Db type not imported directly
	db: any,
	missionId: string,
	outDir: string,
): Promise<void> {
	// ── Conversation → conversation.md ──────────────────────────────────────
	const msgs = await db
		.collection("conversationMessages")
		.find({ missionId })
		.sort({ turnNumber: 1, seqInTurn: 1 })
		.toArray();

	let md = `# Conversation — ${missionId}\n\n`;
	let lastMentalMapHtml = "";
	for (const m of msgs) {
		// StoredMessage stores content under m.message (pi-ai Message or SummaryMessage),
		// not directly on the MongoDB doc.
		const msg = m.message as { role?: string; content?: unknown };
		const role = msg?.role ?? "unknown";
		const tag = m.isReflection ? " *(reflection)*" : "";
		const turn = `turn=${m.turnNumber} seq=${m.seqInTurn}${m.callSeq != null ? ` call=${m.callSeq}` : ""}`;
		md += `## [${turn}] ${role}${tag}\n`;
		if (m.mentalMapHtml) lastMentalMapHtml = m.mentalMapHtml;

		const content = msg?.content;
		if (typeof content === "string") {
			md += `\`\`\`\n${content.slice(0, 2000)}${content.length > 2000 ? "\n…(truncated)" : ""}\n\`\`\`\n\n`;
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if (block.type === "text") {
					md += `\`\`\`\n${String(block.text).slice(0, 2000)}${String(block.text).length > 2000 ? "\n…(truncated)" : ""}\n\`\`\`\n\n`;
				} else if (block.type === "tool_use" || block.type === "toolCall") {
					// Anthropic tool_use block OR pi-ai toolCall block
					const name = block.name ?? block.toolName ?? "(unknown)";
					const input = block.input ?? block.parameters ?? {};
					const inputStr = JSON.stringify(input).slice(0, 500);
					md += `**tool_use** \`${name}\` id=${block.id ?? ""}\n\`\`\`json\n${inputStr}\n\`\`\`\n\n`;
				} else if (block.type === "tool_result") {
					const body = Array.isArray(block.content)
						? block.content.map((c: { text?: string }) => c.text ?? "").join("")
						: String(block.content ?? "");
					md += `**tool_result** for=${block.tool_use_id}\n\`\`\`\n${body.slice(0, 1000)}${body.length > 1000 ? "\n…(truncated)" : ""}\n\`\`\`\n\n`;
				} else {
					md += `*(block type=${block.type})*\n\n`;
				}
			}
		} else {
			md += `*(no content)*\n\n`;
		}
	}
	writeFileSync(join(outDir, "conversation.md"), md);

	// ── Mental map → mental-map.html ────────────────────────────────────────
	if (lastMentalMapHtml) {
		writeFileSync(join(outDir, "mental-map.html"), lastMentalMapHtml);
	}

	// ── LLM call log → llm-calls.json ───────────────────────────────────────
	const calls = await db
		.collection("llmCallLog")
		.find({ missionId })
		.sort({ savedAt: 1 })
		.toArray();
	writeFileSync(join(outDir, "llm-calls.json"), JSON.stringify(calls, null, 2));

	// ── Mailbox → mailbox.json ───────────────────────────────────────────────
	const mailbox = await db
		.collection("mailbox")
		.find({ missionId })
		.sort({ createdAt: 1 })
		.toArray();
	writeFileSync(join(outDir, "mailbox.json"), JSON.stringify(mailbox, null, 2));

	console.log(`[test] conversation.md: ${join(outDir, "conversation.md")}`);
	console.log(`[test] mental-map.html: ${join(outDir, "mental-map.html")}`);
	console.log(`[test] llm-calls.json:  ${join(outDir, "llm-calls.json")}`);
	console.log(`[test] mailbox.json:    ${join(outDir, "mailbox.json")}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("integration: data factory end-to-end (Sprint 12)", () => {
	let tmpDir: string;
	let missionId: string;
	let factoryDir: string;
	let userMessages: MailboxMessage[];

	beforeAll(async () => {
		// Clean previous run at start so output files survive for inspection.
		try { rmSync(OUTPUT_DIR, { recursive: true, force: true }); } catch {}
		mkdirSync(OUTPUT_DIR, { recursive: true });

		tmpDir = OUTPUT_DIR;
		chmodSync(tmpDir, 0o755);
		missionId = "data-factory-test";

		// Wipe any leftover MongoDB data from previous runs.
		{
			const { client: cleanClient, db: cleanDb } = await connectMongo(MONGODB_URI!);
			try {
				for (const coll of ["mailbox", "conversationMessages", "llmCallLog"]) {
					await cleanDb.collection(coll).deleteMany({ missionId });
				}
			} finally {
				await cleanClient.close();
			}
		}
		factoryDir = join(tmpDir, "missions", missionId, "shared", "data-factory");
		userMessages = [];

		// Pre-create factory directory with sources.json and fixture raw.json.
		mkdirSync(join(factoryDir, "news", "sp500-news"), { recursive: true });
		writeFileSync(
			join(factoryDir, "sources.json"),
			JSON.stringify(buildSourcesJson(factoryDir), null, 2),
		);
		writeFileSync(
			join(factoryDir, "news", "sp500-news", "raw.json"),
			JSON.stringify(buildRawJson(), null, 2),
		);

		// Grant magi-w1 (the agent's linux user) write access to the pre-created
		// factory dir and all its contents. Without this, refresh.py can't write
		// catalog.json/CSV/digest because it runs as magi-w1 via sudo.
		// Also grant access to the full missions tree so WorkspaceManager can apply
		// its own setfacl without "No such file" errors on the sharedDir.
		const sharedDir = join(tmpDir, "missions", missionId, "shared");
		try {
			execSync(`setfacl -Rm u:magi-w1:rwx "${sharedDir}"`);
		} catch {
			// setfacl not available or magi-w1 does not exist — test may still pass
			// if the orchestrator's provision() applies the ACL before the agent runs.
			console.warn("[test] setfacl failed — ACL may not be applied to pre-created dirs");
		}

		console.log(`\n[test] Factory dir: ${factoryDir}`);
		console.log(`[test] Output preserved at: ${OUTPUT_DIR}`);
	});

	it(
		"agent runs refresh, reads catalog and price data, summarises news digest",
		async () => {
			const { client, db } = await connectMongo(MONGODB_URI!);
			try {
				const baseTeamConfig = loadTeamConfig(TEAM_CONFIG_PATH);
				const teamConfig = {
					...baseTeamConfig,
					mission: { ...baseTeamConfig.mission, id: missionId },
				};

				const mailboxRepo = createMongoMailboxRepository(db, missionId);
				const conversationRepo = createMongoConversationRepository(db);
				const llmCallLog = createMongoLlmCallLogRepository(db);

				const workspaceManager = new WorkspaceManager({
					layout: {
						homeBase: join(tmpDir, "home"),
						missionsBase: join(tmpDir, "missions"),
					},
				});

				const sharedDir = join(tmpDir, "missions", missionId, "shared");
				const scriptPath = join(
					sharedDir,
					"skills", "_platform", "data-factory", "scripts", "refresh.py",
				);
				const digestPath = join(factoryDir, "news", "sp500-news", "digest.json");

				// Inject a task that tells the agent exactly what to do.
				// We provide concrete paths so the agent doesn't need to explore — the goal
				// is to test the data pipeline, not path discovery.
				await mailboxRepo.post({
					missionId,
					from: "user",
					to: ["data-researcher"],
					subject: "Data factory task",
					body: [
						`A data factory has been configured at ${factoryDir}.`,
						``,
						`Please do the following in order:`,
						``,
						`1. Run the data refresh:`,
						`   magi-python3 ${scriptPath} ${sharedDir}`,
						`   (This fetches SPY price data and processes the news digest.)`,
						``,
						`2. Read the catalog to see what was fetched:`,
						`   cat ${factoryDir}/catalog.json`,
						``,
						`3. If SPY data was fetched successfully, show the last 3 rows of:`,
						`   ${factoryDir}/series/yfinance/SPY_daily.csv`,
						``,
						`4. Read the news digest produced by the refresh:`,
						`   cat ${digestPath}`,
						``,
						`5. PostMessage me (user) with a brief report covering:`,
						`   - SPY price/volume summary (latest row from CSV, or "data unavailable" if fetch failed)`,
						`   - A summary of the news items found in the digest`,
					].join("\n"),
				});

				const ac = new AbortController();

				await runOrchestrationLoop(
					{
						teamConfig,
						mailboxRepo,
						conversationRepo,
						llmCallLog,
						model: CLAUDE_SONNET,
						visionModel: CLAUDE_HAIKU,
						workdir: tmpDir,
						workspaceManager,
						maxCycles: 10,
						onUserMessage: (msg) => {
							userMessages.push(msg);
							console.log(`\n[→ USER] ${msg.subject}:\n${msg.body.slice(0, 500)}`);
						},
					},
					ac.signal,
				);

				// ── Assertions ────────────────────────────────────────────────────

				// 1. catalog.json must exist (refresh.py ran).
				expect(
					existsSync(join(factoryDir, "catalog.json")),
					"catalog.json must be written by refresh.py",
				).toBe(true);

				const catalog = JSON.parse(
					readFileSync(join(factoryDir, "catalog.json"), "utf-8"),
				) as Array<{ id: string; status: string }>;
				const spyEntry = catalog.find((e) => e.id === "yfinance/SPY_daily");
				expect(spyEntry, "catalog must contain SPY entry").toBeDefined();
				// Accept both ok (network available) and error (network unavailable).
				expect(["ok", "error"]).toContain(spyEntry!.status);

				// 2. digest.json must exist (process_news.py ran on fixture raw.json).
				expect(
					existsSync(digestPath),
					"digest.json must be written by process_news.py",
				).toBe(true);

				const digest = JSON.parse(readFileSync(digestPath, "utf-8")) as {
					items: Array<{ is_new: boolean }>;
				};
				expect(digest.items.length).toBeGreaterThan(0);

				// 3. User must have received a substantive report.
				expect(userMessages.length, "agent must PostMessage user").toBeGreaterThan(0);

				const fullReport = userMessages.map((m) => m.body).join(" ").toLowerCase();
				expect(fullReport.length).toBeGreaterThan(100);

				// 4. Report must mention market or stock-related content.
				expect(fullReport).toMatch(/stock|market|s&p|spy|index|price|equity/i);

				console.log("\n[test] All assertions passed.");
				console.log(`[test] catalog.json: ${join(factoryDir, "catalog.json")}`);
				console.log(`[test] digest.json:  ${digestPath}`);
				if (existsSync(join(factoryDir, "series", "yfinance", "SPY_daily.csv"))) {
					console.log(`[test] SPY_daily.csv: ${join(factoryDir, "series", "yfinance", "SPY_daily.csv")}`);
				}
			} finally {
				// Dump MongoDB data alongside the output files for easy inspection.
				// No deleteMany — data is preserved; cleanup happens at next test start.
				try {
					await dumpMongoToFiles(db, missionId, tmpDir);
				} catch (e) {
					console.warn("[test] Failed to dump MongoDB data:", e);
				}
				await client.close();
			}
		},
		5 * 60 * 1_000, // 5 minutes
	);
});
