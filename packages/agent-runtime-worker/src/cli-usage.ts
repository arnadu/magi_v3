#!/usr/bin/env node

/**
 * Query the LLM call audit log and print a tabulated usage/cost report.
 *
 * Usage:
 *   TEAM_CONFIG=<yaml> MONGODB_URI=<uri> node dist/cli-usage.js [options]
 *
 * Options:
 *   --agent <id>      Filter by agent id
 *   --from  <iso>     Start date (ISO 8601, e.g. 2026-03-01)
 *   --to    <iso>     End date   (ISO 8601)
 *   --reflection      Include only reflection calls
 *   --no-reflection   Exclude reflection calls
 *   --detail          Print one row per LLM call (default: aggregate by agent)
 *
 * Environment variables:
 *   MONGODB_URI    required
 *   TEAM_CONFIG    required
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTeamConfig } from "@magi/agent-config";
import { config as dotenvConfig } from "dotenv";

dotenvConfig({
	path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env"),
	quiet: true,
});

import { createMongoLlmCallLogRepository } from "./llm-call-log.js";
import type { LlmCallLogEntry } from "./llm-call-log.js";
import { connectMongo } from "./mongo.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 4): string {
	return n.toFixed(decimals);
}

function fmtCost(usd: number): string {
	return `$${usd.toFixed(4)}`;
}

function fmtK(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function rpad(s: string, width: number): string {
	return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

interface AgentTotals {
	agentId: string;
	calls: number;
	reflectionCalls: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const mongoUri = process.env.MONGODB_URI;
	const teamConfigPath = process.env.TEAM_CONFIG;

	if (!mongoUri || !teamConfigPath) {
		console.error(
			"Usage: TEAM_CONFIG=<yaml> MONGODB_URI=<uri> cli:usage [options]",
		);
		process.exit(1);
	}

	const teamConfig = loadTeamConfig(teamConfigPath);
	const missionId = teamConfig.mission.id;

	// Parse flags.
	const args = process.argv.slice(2);
	const get = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		return i !== -1 ? args[i + 1] : undefined;
	};
	const has = (flag: string): boolean => args.includes(flag);

	const agentFilter = get("--agent");
	const fromArg = get("--from");
	const toArg = get("--to");
	const reflectionOnly = has("--reflection");
	const noReflection = has("--no-reflection");
	const detail = has("--detail");

	const filter: Parameters<typeof repo.query>[0] = { missionId };
	if (agentFilter) filter.agentId = agentFilter;
	if (fromArg) filter.from = new Date(fromArg);
	if (toArg) filter.to = new Date(toArg);
	if (reflectionOnly) filter.isReflection = true;
	if (noReflection) filter.isReflection = false;

	const { client, db } = await connectMongo(mongoUri);
	const repo = createMongoLlmCallLogRepository(db);

	try {
		const entries = await repo.query(filter);

		if (entries.length === 0) {
			console.log("No LLM call log entries found for the given filter.");
			return;
		}

		if (detail) {
			printDetail(entries);
		} else {
			printAggregateSummary(entries, missionId);
		}
	} finally {
		await client.close();
	}
}

// ---------------------------------------------------------------------------
// Detail view: one row per LLM call
// ---------------------------------------------------------------------------

function printDetail(entries: LlmCallLogEntry[]): void {
	const sep = "─".repeat(120);
	console.log(sep);
	console.log(
		pad("Time", 24) +
			pad("Agent", 20) +
			pad("Turn", 6) +
			pad("Refl", 6) +
			rpad("Input", 8) +
			rpad("Output", 8) +
			rpad("CacheR", 8) +
			rpad("CacheW", 8) +
			rpad("Cost", 10) +
			"  Stop",
	);
	console.log(sep);
	for (const e of entries) {
		const ts = e.savedAt.toISOString().replace("T", " ").slice(0, 19);
		const cost = e.usage.cost.totalCostUsd;
		console.log(
			pad(ts, 24) +
				pad(e.agentId, 20) +
				rpad(String(e.turnNumber), 6) +
				rpad(e.isReflection ? "✓" : "", 6) +
				rpad(fmtK(e.usage.inputTokens), 8) +
				rpad(fmtK(e.usage.outputTokens), 8) +
				rpad(fmtK(e.usage.cacheReadTokens), 8) +
				rpad(fmtK(e.usage.cacheWriteTokens), 8) +
				rpad(fmtCost(cost), 10) +
				"  " +
				e.output.stopReason,
		);
	}
	console.log(sep);

	// Totals row.
	const totals = entries.reduce(
		(acc, e) => {
			acc.inputTokens += e.usage.inputTokens;
			acc.outputTokens += e.usage.outputTokens;
			acc.cacheReadTokens += e.usage.cacheReadTokens;
			acc.cacheWriteTokens += e.usage.cacheWriteTokens;
			acc.totalCostUsd += e.usage.cost.totalCostUsd;
			return acc;
		},
		{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
	);

	console.log(
		pad(`TOTAL (${entries.length} calls)`, 56) +
			rpad(fmtK(totals.inputTokens), 8) +
			rpad(fmtK(totals.outputTokens), 8) +
			rpad(fmtK(totals.cacheReadTokens), 8) +
			rpad(fmtK(totals.cacheWriteTokens), 8) +
			rpad(fmtCost(totals.totalCostUsd), 10),
	);
}

// ---------------------------------------------------------------------------
// Aggregate view: one row per agent + totals
// ---------------------------------------------------------------------------

function printAggregateSummary(entries: LlmCallLogEntry[], missionId: string): void {
	// Group by agentId.
	const byAgent = new Map<string, AgentTotals>();
	for (const e of entries) {
		let agg = byAgent.get(e.agentId);
		if (!agg) {
			agg = {
				agentId: e.agentId,
				calls: 0,
				reflectionCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalCostUsd: 0,
			};
			byAgent.set(e.agentId, agg);
		}
		agg.calls++;
		if (e.isReflection) agg.reflectionCalls++;
		agg.inputTokens += e.usage.inputTokens;
		agg.outputTokens += e.usage.outputTokens;
		agg.cacheReadTokens += e.usage.cacheReadTokens;
		agg.cacheWriteTokens += e.usage.cacheWriteTokens;
		agg.totalCostUsd += e.usage.cost.totalCostUsd;
	}

	const rows = [...byAgent.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd);

	const first = entries[0]!.savedAt.toISOString().slice(0, 19).replace("T", " ");
	const last = entries[entries.length - 1]!.savedAt.toISOString().slice(0, 19).replace("T", " ");

	console.log(`\nLLM Call Audit Log — mission: ${missionId}`);
	console.log(`Period: ${first} → ${last}  (${entries.length} total calls)\n`);

	const sep = "─".repeat(100);
	console.log(sep);
	console.log(
		pad("Agent", 22) +
			rpad("Calls", 7) +
			rpad("Refl", 6) +
			rpad("Input(k)", 10) +
			rpad("Output(k)", 11) +
			rpad("CacheR(k)", 11) +
			rpad("CacheW(k)", 11) +
			rpad("Cost(USD)", 12),
	);
	console.log(sep);

	for (const r of rows) {
		console.log(
			pad(r.agentId, 22) +
				rpad(String(r.calls), 7) +
				rpad(String(r.reflectionCalls), 6) +
				rpad(fmt(r.inputTokens / 1000, 1), 10) +
				rpad(fmt(r.outputTokens / 1000, 1), 11) +
				rpad(fmt(r.cacheReadTokens / 1000, 1), 11) +
				rpad(fmt(r.cacheWriteTokens / 1000, 1), 11) +
				rpad(fmtCost(r.totalCostUsd), 12),
		);
	}

	console.log(sep);

	// Grand totals.
	const grand = rows.reduce(
		(acc, r) => {
			acc.calls += r.calls;
			acc.reflectionCalls += r.reflectionCalls;
			acc.inputTokens += r.inputTokens;
			acc.outputTokens += r.outputTokens;
			acc.cacheReadTokens += r.cacheReadTokens;
			acc.cacheWriteTokens += r.cacheWriteTokens;
			acc.totalCostUsd += r.totalCostUsd;
			return acc;
		},
		{
			calls: 0,
			reflectionCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCostUsd: 0,
		},
	);

	console.log(
		pad("TOTAL", 22) +
			rpad(String(grand.calls), 7) +
			rpad(String(grand.reflectionCalls), 6) +
			rpad(fmt(grand.inputTokens / 1000, 1), 10) +
			rpad(fmt(grand.outputTokens / 1000, 1), 11) +
			rpad(fmt(grand.cacheReadTokens / 1000, 1), 11) +
			rpad(fmt(grand.cacheWriteTokens / 1000, 1), 11) +
			rpad(fmtCost(grand.totalCostUsd), 12),
	);
	console.log();

	// Cost breakdown.
	const totalCost = rows.reduce(
		(acc, r) => {
			acc.inputCostUsd = 0;
			acc.outputCostUsd = 0;
			acc.cacheReadCostUsd = 0;
			acc.cacheWriteCostUsd = 0;
			return acc;
		},
		{ inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0 },
	);

	// Recompute cost breakdown from entries (aggregated AgentTotals don't break it out).
	const breakdown = entries.reduce(
		(acc, e) => {
			acc.inputCostUsd += e.usage.cost.inputCostUsd;
			acc.outputCostUsd += e.usage.cost.outputCostUsd;
			acc.cacheReadCostUsd += e.usage.cost.cacheReadCostUsd;
			acc.cacheWriteCostUsd += e.usage.cost.cacheWriteCostUsd;
			return acc;
		},
		{ inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWriteCostUsd: 0 },
	);
	void totalCost; // unused after refactor above

	console.log("Cost breakdown:");
	console.log(`  Input:       ${fmtCost(breakdown.inputCostUsd)}`);
	console.log(`  Output:      ${fmtCost(breakdown.outputCostUsd)}`);
	console.log(`  Cache read:  ${fmtCost(breakdown.cacheReadCostUsd)}`);
	console.log(`  Cache write: ${fmtCost(breakdown.cacheWriteCostUsd)}`);
	console.log(`  TOTAL:       ${fmtCost(grand.totalCostUsd)}\n`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
