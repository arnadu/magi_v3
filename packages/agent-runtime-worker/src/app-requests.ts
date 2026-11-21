/**
 * Requests agents write to declare and control apps (ADR-0037 decision 6;
 * operations app.declare, app.control). Like jobs and schedules, a request
 * is a file in a shared drop directory and its author is the file's owner
 * (`safe-owned-file.ts`); it carries no agent id of its own.
 *
 *   shared/apps/requests/<id>.json   written by agents (sticky, like /tmp)
 *   shared/apps/answers/<id>.json    the daemon's answer to that request
 *   shared/apps/status/<name>.json   each app's state, without its capability
 *
 * The `serve-app` skill's script writes a request, waits for its answer,
 * then follows the app's status file until it runs or fails.
 */

import {
	chmodSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
	type AppKind,
	entryFile,
	type MissionAppDoc,
} from "@magi/agent-config";
import type { AppDeclaration } from "./app-store.js";
import type { AppSupervisor, Outcome } from "./app-supervisor.js";
import { type OwnerCheckDeps, ownerOfRequestFile } from "./safe-owned-file.js";
import { readInside, writeFileInside } from "./safe-path.js";

const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
export const APP_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 300;
const ANSWER_TTL_MS = 24 * 60 * 60_000;
const KINDS: readonly AppKind[] = ["jupyter", "gradio", "site"];
const ACTIONS = ["declare", "start", "stop", "remove"] as const;
type Action = (typeof ACTIONS)[number];

export interface AppRequestDeps extends OwnerCheckDeps {
	sharedDir: string;
	supervisor: Pick<AppSupervisor, "declare" | "start" | "stop" | "remove">;
	store: {
		get(name: string): Promise<MissionAppDoc | null>;
		list(): Promise<MissionAppDoc[]>;
	};
	/** The owner's private workdir: one of the two places an app's files may live. */
	workdirOf(agentId: string): string | undefined;
	/** Agents that may act on any app (the mission copilot). */
	actsOnAny: ReadonlySet<string>;
	notify(agentId: string, subject: string, body: string): Promise<void>;
	now?: () => number;
}

export function appDirs(sharedDir: string) {
	const root = join(sharedDir, "apps");
	return {
		requests: join(root, "requests"),
		answers: join(root, "answers"),
		status: join(root, "status"),
	};
}

/** The request directory is world-writable with the sticky bit (see `ensureSubmissionDir` for jobs). */
export function ensureAppDirs(sharedDir: string): void {
	const d = appDirs(sharedDir);
	for (const dir of [d.requests, d.answers, d.status])
		mkdirSync(dir, { recursive: true });
	try {
		chmodSync(d.requests, 0o1777);
	} catch (e) {
		console.error(
			`[apps] could not make ${d.requests} writable for agents: ${(e as Error).message}; agents cannot declare apps`,
		);
	}
}

type Checked =
	| { ok: true; action: "declare"; declaration: AppDeclaration }
	| { ok: true; action: Exclude<Action, "declare">; name: string }
	| { ok: false; message: string };

/** The path, resolved, inside the owner's workdir or `shared/`; null when it is anywhere else. */
function containedPath(path: unknown, roots: string[]): string | null {
	if (typeof path !== "string" || !path.startsWith("/")) return null;
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return null;
	}
	for (const root of roots) {
		const r = realpathSync(root);
		const rel = relative(r, real);
		if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep)))
			return real;
	}
	return null;
}

function checkRequest(
	raw: unknown,
	owner: string,
	deps: AppRequestDeps,
): Checked {
	if (typeof raw !== "object" || raw === null)
		return { ok: false, message: "not a JSON object" };
	const r = raw as Record<string, unknown>;
	if (!ACTIONS.includes(r.action as Action))
		return {
			ok: false,
			message: `action must be one of ${ACTIONS.join(", ")}`,
		};
	if (typeof r.name !== "string" || !APP_NAME_RE.test(r.name))
		return {
			ok: false,
			message:
				"name must be lowercase letters, digits and dashes, starting with a letter, at most 40",
		};
	const action = r.action as Action;
	if (action !== "declare") return { ok: true, action, name: r.name };

	if (!KINDS.includes(r.kind as AppKind))
		return { ok: false, message: `kind must be one of ${KINDS.join(", ")}` };
	const kind = r.kind as AppKind;
	const workdir = deps.workdirOf(owner);
	const roots = workdir ? [workdir, deps.sharedDir] : [deps.sharedDir];
	const path = containedPath(r.path, roots);
	if (!path)
		return {
			ok: false,
			message:
				"path must be an absolute path to an existing file or folder in your workdir or the shared folder",
		};
	const isDir = statSync(path).isDirectory();
	if (kind === "gradio" ? isDir || !path.endsWith(".py") : !isDir)
		return {
			ok: false,
			message:
				kind === "gradio"
					? "a gradio app's path is its .py file"
					: `a ${kind} app's path is a folder`,
		};
	let handlers: string | undefined;
	if (r.handlers !== undefined) {
		if (kind !== "site")
			return { ok: false, message: "handlers are for a site only" };
		const h = containedPath(r.handlers, roots);
		if (!h || !h.endsWith(".py") || statSync(h).isDirectory())
			return {
				ok: false,
				message:
					"handlers must be a .py file in your workdir or the shared folder",
			};
		handlers = h;
	}
	const description = r.description ?? "";
	if (typeof description !== "string" || description.length > MAX_DESCRIPTION)
		return {
			ok: false,
			message: `description must be text of at most ${MAX_DESCRIPTION} characters`,
		};
	return {
		ok: true,
		action,
		declaration: { name: r.name, owner, kind, path, handlers, description },
	};
}

async function act(
	c: Checked,
	owner: string,
	deps: AppRequestDeps,
): Promise<Outcome> {
	if (!c.ok) return c;
	if (c.action === "declare") return deps.supervisor.declare(c.declaration);
	const app = await deps.store.get(c.name);
	if (!app) return { ok: false, message: `no app named ${c.name}` };
	if (app.owner !== owner && !deps.actsOnAny.has(owner))
		return { ok: false, message: `app ${c.name} belongs to ${app.owner}` };
	const r =
		c.action === "start"
			? await deps.supervisor.start(c.name)
			: c.action === "stop"
				? await deps.supervisor.stop(c.name, `stopped by ${owner}`)
				: await deps.supervisor.remove(c.name);
	if (r.ok && c.action !== "start" && app.owner !== owner)
		await deps.notify(
			app.owner,
			`App ${c.name} ${c.action === "stop" ? "stopped" : "removed"}`,
			`${owner} ${c.action === "stop" ? "stopped" : "removed"} your app ${c.name}.`,
		);
	return r;
}

/** One pass over the request directory; then the status files are rewritten. */
export async function processAppRequests(deps: AppRequestDeps): Promise<void> {
	const dirs = appDirs(deps.sharedDir);
	const files = readdirSync(
		entryFile(["app.declare", "app.control"], dirs.requests),
	)
		.filter((f) => f.endsWith(".json"))
		.sort();
	for (const file of files) {
		const id = file.slice(0, -".json".length);
		const path = join(dirs.requests, file);
		const owned = ownerOfRequestFile(path, MAX_REQUEST_BYTES, deps);
		if (owned.kind === "gone") continue;
		let outcome: Outcome;
		let owner: string | undefined;
		if (!REQUEST_ID_RE.test(id))
			outcome = { ok: false, message: "file name is not a request id" };
		else if (owned.kind === "refused")
			outcome = { ok: false, message: owned.reason };
		else {
			owner = owned.owner;
			let raw: unknown;
			try {
				raw = JSON.parse(
					readInside(dirs.requests, file, {
						maxBytes: MAX_REQUEST_BYTES,
					}).bytes.toString("utf8"),
				);
			} catch (e) {
				raw = undefined;
				outcome = {
					ok: false,
					message: `unreadable or malformed: ${(e as Error).message}`,
				};
			}
			outcome ??= await act(checkRequest(raw, owner, deps), owner, deps).catch(
				(e: Error): Outcome => ({ ok: false, message: `failed: ${e.message}` }),
			);
		}
		try {
			unlinkSync(path);
		} catch (e) {
			console.error(
				`[apps] could not remove request ${file}: ${(e as Error).message}; it will be answered again`,
			);
		}
		if (!outcome.ok)
			console.error(
				`[apps] request ${file} from ${owner ?? "an unknown owner"} refused: ${outcome.message}`,
			);
		if (REQUEST_ID_RE.test(id))
			writeFileInside(
				deps.sharedDir,
				`apps/answers/${file}`,
				JSON.stringify(
					{
						requestId: id,
						by: owner,
						...outcome,
						at: new Date(deps.now?.() ?? Date.now()).toISOString(),
					},
					null,
					2,
				),
			);
	}
	await writeStatusFiles(deps);
	pruneAnswers(deps);
}

/** What agents may see of an app: everything but its capability and slot. */
export function publicStatus(a: MissionAppDoc) {
	return {
		name: a.name,
		owner: a.owner,
		kind: a.kind,
		path: a.path,
		description: a.description,
		status: a.status,
		lastError: a.lastError,
		lastOpenedAt: a.lastOpenedAt,
		rssMb: a.rssMb,
		restartsLastHour: a.restarts.length,
		updatedAt: a.updatedAt,
	};
}

async function writeStatusFiles(deps: AppRequestDeps): Promise<void> {
	const apps = await deps.store.list();
	const names = new Set(apps.map((a) => `${a.name}.json`));
	for (const a of apps)
		writeFileInside(
			deps.sharedDir,
			`apps/status/${a.name}.json`,
			JSON.stringify(publicStatus(a), null, 2),
		);
	const dir = appDirs(deps.sharedDir).status;
	for (const f of readdirSync(dir))
		if (!names.has(f))
			try {
				unlinkSync(join(dir, f));
			} catch (e) {
				console.error(
					`[apps] could not remove stale status file ${f}: ${(e as Error).message}`,
				);
			}
}

function pruneAnswers(deps: AppRequestDeps): void {
	const dir = appDirs(deps.sharedDir).answers;
	const cutoff = (deps.now?.() ?? Date.now()) - ANSWER_TTL_MS;
	for (const f of readdirSync(dir)) {
		try {
			if (statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f));
		} catch (e) {
			console.error(
				`[apps] could not prune answer ${f}: ${(e as Error).message}`,
			);
		}
	}
}
