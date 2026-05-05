#!/usr/bin/env node
/**
 * Seed MongoDB with mission templates from config/teams/.
 *
 * Reads every *.yaml file under config/teams/ (excluding config/teams/test/)
 * along with all companion files in the matching directory (skills/, playbook.json,
 * OPERATOR_GUIDE.md, etc.) and upserts them into the MongoDB `templates` collection.
 *
 * Usage:
 *   node scripts/seed-templates.mjs              # insert new, skip existing
 *   node scripts/seed-templates.mjs --force      # upsert (overwrite existing)
 *   MONGODB_URI=mongodb+srv://... node scripts/seed-templates.mjs
 *
 * The script reads MONGODB_URI from the environment or from a .env file at the
 * repo root.  For prod, pass the URI directly:
 *
 *   MONGODB_URI="mongodb+srv://user:pass@cluster/magi-prod" node scripts/seed-templates.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), "..");

// ---------------------------------------------------------------------------
// Load .env if present (dev mode)
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
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  /* no .env file — rely on environment */
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const force = args.includes("--force");

// ---------------------------------------------------------------------------
// Validate env
// ---------------------------------------------------------------------------
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
  console.error(
    "Error: MONGODB_URI is required.\n" +
      "  Set it in .env or pass it directly:\n" +
      '  MONGODB_URI="mongodb+srv://..." node scripts/seed-templates.mjs',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Collect team files
// ---------------------------------------------------------------------------
function collectFiles(dir, rootDir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, rootDir));
    } else {
      try {
        results.push({
          path: relative(rootDir, full),
          content: readFileSync(full, "utf-8"),
        });
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const { MongoClient } = await import("mongodb");
const client = new MongoClient(mongoUri);

try {
  await client.connect();
  const dbName = client.options.dbName ?? "magi";
  const db = client.db();
  const col = db.collection("templates");

  console.log(`Connected to MongoDB (db: ${dbName})`);
  console.log(`Mode: ${force ? "upsert (--force)" : "insert-new-only"}\n`);

  const teamsDir = join(REPO_ROOT, "config", "teams");
  let yamlFiles;
  try {
    yamlFiles = readdirSync(teamsDir).filter((f) => f.endsWith(".yaml"));
  } catch (e) {
    console.error(`Error reading ${teamsDir}: ${e.message}`);
    process.exit(1);
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of yamlFiles) {
    const id = basename(file, ".yaml");
    let yaml;
    try {
      yaml = readFileSync(join(teamsDir, file), "utf-8");
    } catch (e) {
      console.warn(`  ⚠  Could not read ${file}: ${e.message}`);
      continue;
    }

    const teamDir = join(teamsDir, id);
    const teamFiles = collectFiles(teamDir, teamDir);

    // Extract display name from YAML without a full parse.
    const nameMatch = yaml.match(/^\s*name:\s*["']?([^"'\n]+)["']?/m);
    const name = nameMatch ? nameMatch[1].trim() : id;

    const now = new Date();
    const existing = await col.findOne({ _id: id });

    if (existing && !force) {
      // Backfill teamFiles if missing without touching anything else.
      if (!existing.teamFiles || existing.teamFiles.length === 0) {
        await col.updateOne(
          { _id: id },
          { $set: { teamFiles, updatedAt: now } },
        );
        console.log(
          `  ↳  ${id} — backfilled ${teamFiles.length} team files (YAML unchanged)`,
        );
        updated++;
      } else {
        console.log(`  –  ${id} — already exists, skipping (use --force to overwrite)`);
        skipped++;
      }
      continue;
    }

    if (existing && force) {
      await col.replaceOne(
        { _id: id },
        { _id: id, name, teamConfigYaml: yaml, teamFiles, createdAt: existing.createdAt, updatedAt: now },
      );
      console.log(`  ✓  ${id} ("${name}") — updated (${teamFiles.length} files)`);
      updated++;
    } else {
      await col.insertOne({
        _id: id,
        name,
        teamConfigYaml: yaml,
        teamFiles,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`  ✓  ${id} ("${name}") — inserted (${teamFiles.length} files)`);
      inserted++;
    }
  }

  console.log(
    `\nDone. ${inserted} inserted, ${updated} updated, ${skipped} skipped.`,
  );
} finally {
  await client.close();
}
