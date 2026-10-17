#!/usr/bin/env node
/**
 * Migrate existing `missions` documents from `teamConfigYaml` (YAML text) to
 * the structured `mission`/`agents`/`missionCopilotLimits` fields (ADR-0021).
 *
 * Additive and idempotent — only ever adds fields and inserts into the new
 * `missionConfigRevisions` collection; never touches `teamConfigYaml`,
 * `teamFiles`, `status`, `machineId`, or anything else. Safe to run once
 * against real, currently-running production Mongo before the read/write/
 * boot cutover deploys (see the ADR and the Stage 3a plan notes for the
 * full safety argument).
 *
 * HISTORICAL — the ADR-0021 cutover ran on every environment in Sprint 24.
 * Every mission created since is written in structured form directly and
 * `teamConfigYaml` is no longer read by any code path, so there is nothing
 * left for this script to migrate. It is kept for the record and for a
 * restored pre-cutover backup only; it refuses to run without
 * `--historical-ok` so it cannot be mistaken for a maintenance task.
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node scripts/migrate-mission-config-to-structured.mjs --historical-ok
 *   (there is no dry-run mode — this writes)
 *
 * `${VAR}`-style substitution in team config was removed from
 * `parseTeamConfig` (ENV1, 2026-10-15 audit — it let tenant-supplied config
 * read arbitrary server environment variables back out through the API).
 * Any already-migrated `teamConfigYaml` that relied on it was expanded at
 * migration time and is unaffected; this script no longer performs
 * expansion on anything it parses now. The empty-string suspicion check
 * below predates the removal and is kept as a general sanity check on
 * parsed output, not specifically for substitution failures.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTeamConfigYaml } from "@magi/agent-config";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");

// ---------------------------------------------------------------------------
// Load .env if present (dev mode) — matches scripts/seed-templates.mjs.
// ---------------------------------------------------------------------------
try {
	const envPath = join(REPO_ROOT, ".env");
	const lines = readFileSync(envPath, "utf-8").split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		const key = trimmed.slice(0, eq).trim();
		const val = trimmed
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key && !(key in process.env)) process.env[key] = val;
	}
} catch {
	/* no .env file — rely on environment */
}

if (!process.argv.includes("--historical-ok")) {
	console.error(
		"This migration is historical (ADR-0021 cutover, Sprint 24) and has nothing to do on a current database.\n" +
			"If you are really restoring a pre-cutover backup, re-run with --historical-ok.",
	);
	process.exit(2);
}

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
	console.error(
		"Error: MONGODB_URI is required.\n" +
			"  Set it in .env or pass it directly:\n" +
			'  MONGODB_URI="mongodb+srv://..." node scripts/migrate-mission-config-to-structured.mjs',
	);
	process.exit(1);
}

/** True if any resolved string value in the config is suspiciously empty —
 * e.g. an unset `${VAR}` substitution that resolved to "". Not a hard
 * failure (an intentionally empty field is valid) — just flagged in the
 * summary for a human to double-check. */
function findSuspiciousEmptyValues(obj, path = "") {
	const hits = [];
	if (typeof obj === "string") {
		if (obj === "") hits.push(path || "(root)");
		return hits;
	}
	if (Array.isArray(obj)) {
		obj.forEach((v, i) => hits.push(...findSuspiciousEmptyValues(v, `${path}[${i}]`)));
		return hits;
	}
	if (obj && typeof obj === "object") {
		for (const [k, v] of Object.entries(obj)) {
			hits.push(...findSuspiciousEmptyValues(v, path ? `${path}.${k}` : k));
		}
	}
	return hits;
}

const { MongoClient } = await import("mongodb");
// ignoreUndefined: a mission with no missionCopilotLimits configured yields
// `teamConfig.missionCopilotLimits === undefined` below — without this flag
// the driver serializes that as a literal stored `null`, which then fails
// parseTeamConfig's `.optional()` (not `.nullable()`) validation on every
// subsequent read. See packages/agent-runtime-worker/src/mongo.ts's doc
// comment for the full incident.
const client = new MongoClient(mongoUri, { ignoreUndefined: true });

try {
	await client.connect();
	const dbName = client.options.dbName ?? "magi";
	const db = client.db();
	const missions = db.collection("missions");
	const revisions = db.collection("missionConfigRevisions");

	console.log(`Connected to MongoDB (db: ${dbName})\n`);

	// Idempotency guard: `mission: { $exists: false }` means "not yet migrated."
	// Re-running the script after a partial run only touches what's left.
	const candidates = await missions
		.find({ teamConfigYaml: { $exists: true, $ne: null }, mission: { $exists: false } })
		.toArray();

	console.log(`Found ${candidates.length} mission(s) to migrate.\n`);

	let migrated = 0;
	let failed = 0;
	const failures = [];
	const suspicious = [];

	for (const doc of candidates) {
		const missionId = doc.missionId;
		let teamConfig;
		try {
			teamConfig = parseTeamConfigYaml(doc.teamConfigYaml);
		} catch (e) {
			failed++;
			failures.push({ missionId, error: e.message });
			console.error(`  ✗  ${missionId} — parse/validate failed: ${e.message}`);
			continue;
		}

		const snapshot = {
			mission: teamConfig.mission,
			agents: teamConfig.agents,
			missionCopilotLimits: teamConfig.missionCopilotLimits,
		};

		const emptyHits = findSuspiciousEmptyValues(snapshot);
		if (emptyHits.length > 0) {
			suspicious.push({ missionId, fields: emptyHits });
		}

		const now = new Date();
		await missions.updateOne(
			{ missionId },
			{
				$set: {
					mission: snapshot.mission,
					agents: snapshot.agents,
					missionCopilotLimits: snapshot.missionCopilotLimits,
					updatedAt: now,
				},
			},
		);
		await revisions.insertOne({
			missionId,
			at: now,
			by: "migration",
			mission: snapshot.mission,
			agents: snapshot.agents,
			missionCopilotLimits: snapshot.missionCopilotLimits,
		});

		migrated++;
		console.log(
			`  ✓  ${missionId} ("${snapshot.mission.name}") — ${snapshot.agents.length} agent(s) migrated`,
		);
	}

	console.log(
		`\nDone. ${candidates.length} found, ${migrated} migrated, ${failed} failed.`,
	);
	if (failures.length > 0) {
		console.log("\nFailures (left untouched — teamConfigYaml unaffected):");
		for (const f of failures) console.log(`  - ${f.missionId}: ${f.error}`);
	}
	if (suspicious.length > 0) {
		console.log(
			"\nSuspicious empty values found (may indicate an unresolved ${VAR} " +
				"substitution — verify these missions ran with the right env vars):",
		);
		for (const s of suspicious) {
			console.log(`  - ${s.missionId}: ${s.fields.join(", ")}`);
		}
	}
} finally {
	await client.close();
}
