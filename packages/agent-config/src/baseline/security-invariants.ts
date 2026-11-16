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
		enforcedBy: [],
	},
	{
		id: "sec.authorized",
		text: "Every request about a mission is checked against the caller's right to that mission before it reaches the operation's home.",
		enforcedBy: [],
	},
	{
		id: "sec.tenant-scoped",
		text: "Every database query on mission data is scoped to one mission, and to one user where the data is a user's; input supplies values, never operators or field names.",
		enforcedBy: [],
	},
	{
		id: "sec.no-secrets-to-agents",
		text: "No secret reaches an agent's or a job's environment, prompt, files or tool results.",
		enforcedBy: [],
	},
	{
		id: "sec.secrets-not-recorded",
		text: "No secret value is written to logs, conversations or model-call records.",
		enforcedBy: [],
	},
	{
		id: "sec.contained-paths",
		text: "Every path that comes from input is resolved inside its root, after following symlinks, before it is used.",
		enforcedBy: [],
	},
	{
		id: "sec.safe-egress",
		text: "Every outbound request to a URL an agent or the web can influence is checked against internal addresses, at every redirect.",
		enforcedBy: [],
	},
	{
		id: "sec.input-validated",
		text: "Every input from outside a component's trust boundary is checked against a schema before it is used.",
		enforcedBy: [],
	},
	{
		id: "sec.untrusted-text-labelled",
		text: "Text written by agents or taken from the web, when placed in a more privileged actor's context, is marked as data, not instructions.",
		enforcedBy: [],
	},
	{
		id: "sec.output-safe",
		text: "Content written by agents or taken from the web is escaped or sandboxed wherever the cockpit shows it.",
		enforcedBy: [],
	},
	{
		id: "sec.least-privilege",
		text: "Each agent's tools and jobs run as its own OS user. Only the daemon may use `sudo`, only to become an agent's user, with a minimal environment.",
		enforcedBy: [],
	},
	{
		id: "sec.confirmed-effects",
		text: "Every change the control copilot makes, and every GitHub write from either copilot, is a proposal the operator confirms. The mission copilot changes only its own mission, within its ceilings, and reports each change to the operator.",
		enforcedBy: [],
	},
];
