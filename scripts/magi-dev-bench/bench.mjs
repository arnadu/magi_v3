#!/usr/bin/env node
/**
 * MAGI DEV's known-answer benchmark (security assurance plan, step 6d): the real review chain —
 * produce_items.py, review.py, the Investigate tool, a real model — run over cases whose answer is
 * known (scripts/magi-dev-bench/cases.json), scored by code.
 *
 *   node scripts/magi-dev-bench/bench.mjs [--model z-ai/glm-5.2] [--max-usd 5] [--only <id>] [--out <dir>]
 *
 * Per case: a reference copy at the case's commit, laid out as the git-mirror platform task lays
 * it out; the producer turns the case's alerts and guards into items; the pipeline runs them,
 * calling `investigate` on a local stand-in for the Tool API, which runs the real tool with the
 * model and meters every call against --max-usd. The investigator's shell runs in a container
 * with no network and the code mounted read-only (`magi-bench-shell`, built from
 * Dockerfile.shell): model-written commands never touch this machine.
 *
 * Needs a build (npm run build), Docker, and OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) in .env.
 * Writes <out>/report.json; prints a score table.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const W = join(ROOT, "packages", "agent-runtime-worker", "dist");
const SKILL = join(
	ROOT,
	"config",
	"teams",
	"magi-dev",
	"skills",
	"alert-triage",
);
const IMAGE = "magi-bench-shell";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Model keys from .env, without printing them. */
function loadKeys() {
	const env = readFileSync(join(ROOT, ".env"), "utf8");
	for (const name of ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) {
		const m = env.match(new RegExp(`^${name}=(.*)$`, "m"));
		if (m && !process.env[name])
			// The value is the first token: a line may carry a trailing comment.
			process.env[name] = m[1]
				.trim()
				.split(/\s+/)[0]
				.replace(/^["']|["']$/g, "");
	}
}

function git(...args) {
	return execFileSync("git", args, {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	}).trim();
}

/** A reference copy of the repository at `rev`, as git-mirror lays it out. */
function makeReference(refRoot, name, rev) {
	const commit = git("rev-parse", `${rev}^{commit}`);
	const d = join(refRoot, name);
	mkdirSync(join(d, "snapshots", commit), { recursive: true });
	execFileSync("git", [
		"clone",
		"--quiet",
		"--bare",
		ROOT,
		join(d, "mirror.git"),
	]);
	execFileSync("bash", [
		"-c",
		`git -C "${ROOT}" archive --format=tar ${commit} | tar -x -C "${join(d, "snapshots", commit)}"`,
	]);
	symlinkSync(join("snapshots", commit), join(d, "current"));
	writeFileSync(
		join(d, "status.json"),
		JSON.stringify({ kind: "git-mirror", commit }),
	);
	execFileSync("chmod", ["-R", "a+rX", d]);
	return commit;
}

/** The investigator's shell: one container per command, no network, the copies read-only. */
function containerShell(refRoot, name, Type) {
	return {
		name: "Bash",
		operation: "agent.shell",
		description: "Execute a bash command. Returns combined stdout and stderr.",
		parameters: Type.Object({
			command: Type.String(),
			timeout: Type.Optional(Type.Number()),
		}),
		execute: (_id, args) =>
			new Promise((resolve) => {
				const p = spawn("docker", [
					"run",
					"--rm",
					"--network",
					"none",
					"--read-only",
					"--tmpfs",
					"/tmp",
					"-v",
					`${refRoot}:/var/lib/magi/reference:ro`,
					"-w",
					`/var/lib/magi/reference/${name}/current`,
					IMAGE,
					"bash",
					"-c",
					String(args.command),
				]);
				let out = "";
				const take = (b) => {
					if (out.length < 40_000) out += b.toString();
				};
				p.stdout.on("data", take);
				p.stderr.on("data", take);
				const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
				p.on("close", (code) => {
					clearTimeout(timer);
					resolve({
						content: [
							{ type: "text", text: out.slice(0, 40_000) || `(exit ${code})` },
						],
						isError: code !== 0,
					});
				});
			}),
	};
}

async function main() {
	loadKeys();
	const modelId = arg("model", "z-ai/glm-5.2");
	const maxUsd = Number(arg("max-usd", "5"));
	const only = arg("only", null);
	const out = arg("out", join(tmpdir(), `magi-bench-${Date.now()}`));
	const { resolveModel } = await import(join(W, "models.js"));
	const { createInvestigateTool } = await import(
		join(W, "tools", "investigate.js")
	);
	const { Type } = await import("@sinclair/typebox");
	const model = resolveModel(modelId);

	execFileSync(
		"docker",
		["build", "-q", "-t", IMAGE, "-f", join(HERE, "Dockerfile.shell"), HERE],
		{ stdio: "ignore" },
	);
	const { cases } = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
	const refRoot = join(out, "reference");
	rmSync(out, { recursive: true, force: true });
	mkdirSync(refRoot, { recursive: true });
	mkdirSync(join(out, "transcripts"), { recursive: true });
	chmodSync(out, 0o755);

	let spent = 0;
	let calls = 0;
	const token = randomUUID();
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", async () => {
			const send = (status, v) =>
				res
					.writeHead(status, { "Content-Type": "application/json" })
					.end(JSON.stringify(v));
			if (
				req.headers.authorization !== `Bearer ${token}` ||
				req.url !== "/tools/investigate"
			)
				return send(404, { error: "not found" });
			if (spent >= maxUsd)
				return send(200, { error: `benchmark budget of $${maxUsd} reached` });
			const args = JSON.parse(body);
			const tool = createInvestigateTool(
				model,
				{ agentId: "bench", linuxUser: "bench", permittedPaths: [SKILL] },
				{
					workdir: SKILL,
					shell: containerShell(refRoot, args.reference, Type),
					// Every message of every investigation, for reading what went wrong.
					onSubLoopMessage: async (_id, msg) => {
						appendFileSync(
							join(out, "transcripts", `${args.reference}.jsonl`),
							`${JSON.stringify({ call: calls, role: msg.role, stopReason: msg.stopReason, error: msg.errorMessage, content: msg.content })}\n`,
						);
					},
					onSubLoopLlmCall: async (e) => {
						spent += e.response.usage?.cost?.total ?? 0;
					},
				},
			);
			calls++;
			try {
				const r = await tool.execute(`bench-${calls}`, args);
				const text = r.content.map((c) => c.text).join("");
				send(
					200,
					r.isError ? { error: text } : { result: { content: r.content } },
				);
			} catch (e) {
				send(500, { error: String(e) });
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${server.address().port}`;

	const results = [];
	for (const c of cases.filter((x) => !only || x.id === only)) {
		const name = `bench-${c.id}`;
		const before = { spent, calls };
		const commit = makeReference(refRoot, name, c.commit);
		const work = join(out, c.id);
		mkdirSync(work, { recursive: true });
		writeFileSync(
			join(work, "alerts.json"),
			JSON.stringify({ alerts: c.alerts }),
		);
		writeFileSync(
			join(work, "guards.json"),
			JSON.stringify({ guards: c.guards }),
		);
		execFileSync("python3", [
			join(SKILL, "scripts", "produce_items.py"),
			"--reference",
			name,
			"--reference-root",
			refRoot,
			"--alerts",
			join(work, "alerts.json"),
			"--guards",
			join(work, "guards.json"),
			"--out",
			join(work, "items.jsonl"),
		]);
		const env = { ...process.env, MAGI_TOOL_URL: url, MAGI_TOOL_TOKEN: token };
		const started = Date.now();
		// Asynchronous: the stand-in Tool API in this process must keep answering while it runs.
		const { stdout } = await promisify(execFile)(
			"python3",
			[
				join(
					ROOT,
					"packages",
					"skills",
					"review-pipeline",
					"scripts",
					"review.py",
				),
				"--items",
				join(work, "items.jsonl"),
				"--kinds",
				join(SKILL, "kinds"),
				"--state",
				join(work, "state"),
				"--reference",
				name,
				"--reference-root",
				refRoot,
				"--max-calls",
				"12",
			],
			{ env, encoding: "utf8", maxBuffer: 1 << 24 },
		);
		const summary = JSON.parse(stdout.trim().split("\n").pop());
		const ledger = readFileSync(join(work, "state", "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		const status = ledger[0]?.status ?? "none";
		const got =
			status === "finding"
				? "finding"
				: ["failed", "deferred"].includes(status)
					? "error"
					: "none";
		const verdicts = JSON.parse(
			readFileSync(join(work, "state", "verdicts.json"), "utf8"),
		);
		const first = Object.values(verdicts)[0]?.answer ?? null;
		results.push({
			id: c.id,
			commit: commit.slice(0, 10),
			expected: c.expected,
			got,
			status,
			reason: ledger[0]?.reason,
			problems: ledger[0]?.problems ?? [],
			verdict: first?.verdict ?? null,
			calls: calls - before.calls,
			usd: Number((spent - before.spent).toFixed(4)),
			seconds: Math.round((Date.now() - started) / 1000),
			correct: got === c.expected,
			summary,
		});
		const r = results.at(-1);
		console.log(
			`[bench] ${r.id.padEnd(22)} expected ${r.expected.padEnd(7)} got ${r.got.padEnd(7)} (${r.status}, verdict ${r.verdict}) ${r.correct ? "✓" : "✗"}  ${r.calls} calls  $${r.usd}  ${r.seconds}s`,
		);
		if (spent >= maxUsd) {
			console.log(
				`[bench] stopped: $${spent.toFixed(2)} spent, budget $${maxUsd}`,
			);
			break;
		}
	}
	server.close();
	const tp = results.filter(
		(r) => r.expected === "finding" && r.got === "finding",
	).length;
	const fn = results.filter(
		(r) => r.expected === "finding" && r.got !== "finding",
	).length;
	const fp = results.filter(
		(r) => r.expected === "none" && r.got === "finding",
	).length;
	const tn = results.filter(
		(r) => r.expected === "none" && r.got === "none",
	).length;
	const report = {
		model: modelId,
		at: new Date().toISOString(),
		spentUsd: Number(spent.toFixed(4)),
		calls,
		score: {
			tp,
			fn,
			fp,
			tn,
			errors: results.filter((r) => r.got === "error").length,
		},
		results,
	};
	writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
	console.log(
		`[bench] ${modelId}: found ${tp} of ${tp + fn} known findings, ${fp} false alarm(s) in ${fp + tn} clean cases; $${spent.toFixed(2)}, ${calls} investigations. Report: ${join(out, "report.json")}`,
	);
}

if (!existsSync(join(W, "tools", "investigate.js"))) {
	console.error("[bench] build first: npm run build");
	process.exit(1);
}
main().catch((e) => {
	console.error(`[bench] failed: ${e.stack ?? e}`);
	process.exit(1);
});
