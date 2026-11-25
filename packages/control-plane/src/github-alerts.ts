/**
 * The repository's open security alerts, for the agents allowed to triage them (operation
 * `security.read-alerts`). Reached through the mission-copilot gateway, which has already checked
 * the caller holds the mission's token; here, the rest of the rule:
 *
 *   - the mission's owner is a platform admin (`PLATFORM_ADMIN_USER_IDS`), and
 *   - the mission's admin-set `securityAlerts.agents` names the calling agent.
 *
 * Anyone else gets the same 404 as a route that does not exist. The alerts are read with
 * `GITHUB_ALERTS_TOKEN`, a read-only token separate from `GH_TOKEN`, which never leaves the
 * control plane; what is returned is trimmed to what triage needs.
 */
import { parseSecurityAlerts, storedCollection } from "@magi/agent-config";
import type { Db } from "mongodb";
import { GITHUB_REPO } from "./github.js";
import { platformAdminUserIds } from "./spend-policy.js";

const PAGE = 100;
const MAX_PAGES = 3;
const TEXT_CAP = 500;

export type SecurityAlert =
	| {
			source: "code-scanning";
			number: number;
			rule: string;
			tool: string;
			severity: string;
			path: string;
			line: number | null;
			message: string;
			createdAt: string;
	  }
	| {
			source: "dependabot";
			number: number;
			package: string;
			ecosystem: string;
			manifest: string;
			severity: string;
			advisory: string;
			cve: string | null;
			summary: string;
			vulnerableRange: string;
			patched: string | null;
			createdAt: string;
	  };

export type AlertsOutcome =
	| { status: 200; alerts: SecurityAlert[] }
	| { status: 404 | 502 | 503; error: string };

export interface AlertsDeps {
	fetch?: typeof fetch;
	env?: NodeJS.ProcessEnv;
}

type Json = Record<string, unknown>;
const str = (v: unknown, cap = TEXT_CAP) =>
	typeof v === "string" ? v.slice(0, cap) : "";
const at = (o: unknown, ...keys: string[]): unknown =>
	keys.reduce<unknown>(
		(v, k) => (v && typeof v === "object" ? (v as Json)[k] : undefined),
		o,
	);

function codeScanning(a: Json): SecurityAlert {
	const loc = at(a, "most_recent_instance", "location");
	return {
		source: "code-scanning",
		number: Number(a.number),
		rule: str(at(a, "rule", "id"), 200),
		tool: str(at(a, "tool", "name"), 100),
		severity: str(
			at(a, "rule", "security_severity_level") ?? at(a, "rule", "severity"),
			20,
		),
		path: str(at(loc, "path"), 300),
		line:
			typeof at(loc, "start_line") === "number"
				? (at(loc, "start_line") as number)
				: null,
		message: str(at(a, "most_recent_instance", "message", "text")),
		createdAt: str(a.created_at, 40),
	};
}

function dependabot(a: Json): SecurityAlert {
	const cve = at(a, "security_advisory", "cve_id");
	const patched = at(
		a,
		"security_vulnerability",
		"first_patched_version",
		"identifier",
	);
	return {
		source: "dependabot",
		number: Number(a.number),
		package: str(at(a, "dependency", "package", "name"), 200),
		ecosystem: str(at(a, "dependency", "package", "ecosystem"), 40),
		manifest: str(at(a, "dependency", "manifest_path"), 300),
		severity: str(at(a, "security_advisory", "severity"), 20),
		advisory: str(at(a, "security_advisory", "ghsa_id"), 40),
		cve: typeof cve === "string" ? cve.slice(0, 40) : null,
		summary: str(at(a, "security_advisory", "summary"), 300),
		vulnerableRange: str(
			at(a, "security_vulnerability", "vulnerable_version_range"),
			100,
		),
		patched: typeof patched === "string" ? patched.slice(0, 60) : null,
		createdAt: str(a.created_at, 40),
	};
}

/** The `rel="next"` URL of a GitHub `Link` header, only if it stays on the API host. */
export function nextPage(link: string | null): string | null {
	const m = link?.match(/<([^>]+)>;\s*rel="next"/);
	return m?.[1].startsWith("https://api.github.com/") ? m[1] : null;
}

/**
 * Every open alert of one kind, following GitHub's `Link` header for up to MAX_PAGES pages
 * (Dependabot pages by cursor and refuses `page=`); a 404 (no analysis yet) is none.
 */
async function list(
	kind: "code-scanning" | "dependabot",
	token: string,
	doFetch: typeof fetch,
): Promise<Json[]> {
	const out: Json[] = [];
	let url: string | null =
		`https://api.github.com/repos/${GITHUB_REPO}/${kind}/alerts?state=open&per_page=${PAGE}`;
	for (let page = 0; url && page < MAX_PAGES; page++) {
		const res = await doFetch(url, {
			signal: AbortSignal.timeout(15_000),
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (res.status === 404) return out;
		if (!res.ok)
			throw new Error(`GitHub answered ${res.status} for ${kind} alerts`);
		out.push(...((await res.json()) as Json[]));
		url = nextPage(res.headers.get("link"));
	}
	return out;
}

/** Whether the mission and the agent may read alerts: both keys, read fresh from the database. */
async function allowed(
	db: Db,
	missionId: string,
	agentId: string,
	env: NodeJS.ProcessEnv,
) {
	const mission = await storedCollection(db, "missions").findOne(
		{ missionId },
		{ projection: { userId: 1, securityAlerts: 1 } },
	);
	if (!mission?.userId || !platformAdminUserIds(env).has(mission.userId))
		return false;
	try {
		return (
			parseSecurityAlerts(mission.securityAlerts)?.agents.includes(agentId) ??
			false
		);
	} catch {
		return false; // an invalid stored field grants nothing
	}
}

export async function readSecurityAlerts(
	db: Db,
	missionId: string,
	agentId: unknown,
	deps: AlertsDeps = {},
): Promise<AlertsOutcome> {
	const env = deps.env ?? process.env;
	if (
		typeof agentId !== "string" ||
		!(await allowed(db, missionId, agentId, env))
	) {
		return { status: 404, error: "Not found" };
	}
	const token = env.GITHUB_ALERTS_TOKEN;
	if (!token)
		return {
			status: 503,
			error: "Security alerts are not configured on this platform.",
		};
	const doFetch = deps.fetch ?? fetch;
	try {
		const [cs, dep] = await Promise.all([
			list("code-scanning", token, doFetch),
			list("dependabot", token, doFetch),
		]);
		return {
			status: 200,
			alerts: [...cs.map(codeScanning), ...dep.map(dependabot)],
		};
	} catch (e) {
		console.error(
			`[github-alerts] Reading the alerts failed { missionId: "${missionId}", error: "${(e as Error).message}" }; the agent is told GitHub is unavailable`,
		);
		return { status: 502, error: "GitHub is unavailable; try again later." };
	}
}
