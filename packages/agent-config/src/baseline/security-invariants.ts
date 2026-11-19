import type { Invariant } from "./types.js";

/**
 * What must always hold for MAGI to be safe. The threat model and the
 * trust-boundaries table describe the threats and boundaries; these are the
 * guarantees they rely on, each with what enforces it.
 */
export const SECURITY_INVARIANTS: readonly Invariant[] = [
	{
		id: "sec.authenticated",
		text: "Every route and Tool API name requires an authenticated caller (a session, the admin key, the mission's monitor token, a job's tool token), except the entry points of the `infrastructure` class.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"control-plane/src/auth.ts: createAuthMiddleware (session or admin key)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/monitor-server.ts: tokenOk (the mission's monitor token, every route)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tool-api-server.ts: the job's bearer token",
			},
			{
				kind: "runtime",
				where:
					"control-plane/src/mission-copilot-router.ts: the mission's monitor token",
			},
			{ kind: "test" },
		],
	},
	{
		id: "sec.authorized",
		text: "Every request about a mission is checked against the caller's right to that mission before it reaches the operation's home.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"control-plane/src/mission-scope.ts: userFilter (owner, or any mission for an admin)",
			},
			{
				kind: "runtime",
				where:
					"control-plane/src/proxy.ts: owner filter before forwarding to a mission machine",
			},
			{ kind: "test" },
		],
		open: "`mission-resource-routes.ts` keeps a second copy of `userFilter`: one rule, two homes",
	},
	{
		id: "sec.tenant-scoped",
		text: "Every database query on mission data is scoped to one mission, and to one user where the data is a user's; input supplies values, never operators or field names.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"control-plane/src/mission-scope.ts: userFilter on mission queries",
			},
			{ kind: "review" },
		],
		open: "Nothing checks that input supplies values only (never an operator or a field name); a reviewer checks each new query",
	},
	{
		id: "sec.no-secrets-to-agents",
		text: "No secret reaches an agent's or a job's environment, prompt, files or tool results.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tools.ts: runIsolatedToolCall (sudo child with PATH and HOME only)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/job-runner.ts: startJob (minimal env and a scoped, revocable tool token)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tools/data-provider-proxy.ts: providers' keys stay in the daemon",
			},
		],
	},
	{
		id: "sec.secrets-not-recorded",
		text: "No secret value is written to logs, conversations or model-call records.",
		enforcedBy: [],
		open: "Nothing enforces it yet: no redaction before logs, conversations or call records are written",
	},
	{
		id: "sec.contained-paths",
		text: "Every path that comes from input is resolved inside its root, after following symlinks, before it is used.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/safe-path.ts: resolveInside, readInside, writeFileInside",
			},
			{ kind: "test" },
		],
	},
	{
		id: "sec.safe-egress",
		text: "Every outbound request to a URL an agent or the web can influence is checked against internal addresses, at every redirect.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/ssrf.ts: resolveVetted; safe-http.ts: safeGet (every redirect)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tools/browse-web-egress-proxy.ts: the browser's egress proxy",
			},
			{ kind: "test" },
		],
	},
	{
		id: "sec.input-validated",
		text: "Every input from outside a component's trust boundary is checked against a schema before it is used.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tool-args.ts: checkToolArguments (every tool call and Tool API request)",
			},
			{
				kind: "runtime",
				where:
					"control-plane/src/copilot-actions.ts: parseActionPayload (every copilot action)",
			},
			{
				kind: "runtime",
				where: "agent-config/src/loader.ts: the team config schema",
			},
			{ kind: "test" },
		],
	},
	{
		id: "sec.untrusted-text-labelled",
		text: "Text written by agents or taken from the web, when placed in a more privileged actor's context, is marked as data, not instructions.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/mental-map-regions.ts: file-fed regions labelled as data",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tools/fetch-url.ts: the banner on fetched content",
			},
			{ kind: "test" },
		],
		open: "Anomaly text relayed into the copilots' inboxes is not yet marked (AN1, trust-boundaries.md)",
	},
	{
		id: "sec.output-safe",
		text: "Content written by agents or taken from the web is escaped or sandboxed wherever the cockpit shows it.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"cockpit/src/markdown.ts: renderMarkdown (escapes text, allow-lists link schemes)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/monitor-files.ts: handleDownload (SVG and HTML as attachments under a sandbox CSP)",
			},
			{ kind: "test" },
		],
	},
	{
		id: "sec.least-privilege",
		text: "Each agent's tools and jobs run as its own OS user. Only the daemon may use `sudo`, only to become an agent's user, with a minimal environment.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/tools.ts: runIsolatedToolCall (sudo -u the agent's user)",
			},
			{
				kind: "runtime",
				where:
					"agent-runtime-worker/src/job-runner.ts: startJob (sudo -u the file owner's user)",
			},
			{ kind: "test" },
		],
	},
	{
		id: "sec.confirmed-effects",
		text: "Every change the control copilot makes, and every GitHub write from either copilot, is a proposal the operator confirms. The mission copilot changes only its own mission, within its ceilings, and reports each change to the operator.",
		enforcedBy: [
			{
				kind: "runtime",
				where:
					"control-plane/src/copilot-pending-routes.ts: /confirm (claims the action once, runs it as the proposer)",
			},
			{
				kind: "runtime",
				where:
					"control-plane/src/copilot-actions.ts: parseActionPayload (validated when proposed and again when carried out)",
			},
			{ kind: "review" },
		],
	},
];
