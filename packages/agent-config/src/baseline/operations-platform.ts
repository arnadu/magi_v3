import { defineOperations } from "./define-operations.js";

/** The copilot, the platform and the account. See `operations.ts`. */
export const PLATFORM_OPERATIONS = defineOperations([
	// ── Copilot ─────────────────────────────────────────────────────────────
	{
		id: "copilot.ask",
		group: "copilot",
		intent: "Talk to one's copilot",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [
			"One's own copilot only",
			"Within the copilot's limits; spend counts against the operator",
		],
	},
	{
		id: "copilot.propose",
		group: "copilot",
		intent: "Propose a change for the operator to confirm",
		actors: ["CC", "MC"],
		home: "cp-copilot",
		rules: [
			"Validated against the action's schema when proposed and again when carried out",
			"The label the operator sees is written by the server from the validated proposal",
			"MC: issues and resource requests",
		],
	},
	{
		id: "copilot.confirm",
		group: "copilot",
		intent: "Accept a copilot's proposal",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [
			"Carried out once, even if confirmed twice",
			"Carried out with the proposer's rights, never more",
			"The proposer is told the outcome",
		],
	},
	{
		id: "copilot.dismiss",
		group: "copilot",
		intent: "Refuse a copilot's proposal",
		actors: ["OP"],
		home: "cp-copilot",
		rules: ["The proposer is told"],
	},
	{
		id: "copilot.settings",
		group: "copilot",
		intent: "Configure one's own copilot",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [],
	},
	{
		id: "copilot.limits",
		group: "copilot",
		intent: "Set one's own copilot's limits",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [],
	},
	{
		id: "copilot.history",
		group: "copilot",
		intent:
			"What one's copilot did: its turns, transcripts, model calls, files and usage",
		actors: ["OP"],
		home: "cp-copilot",
		rules: ["One's own copilot only"],
		read: true,
	},
	{
		id: "copilot.wake",
		group: "copilot",
		intent: "Run a copilot when its mailbox has news",
		actors: ["PLT"],
		home: "cp-copilot",
		rules: ["Within the copilot's limits", "One turn per copilot at a time"],
	},
	// ── Platform and account ────────────────────────────────────────────────
	{
		id: "issue.track",
		group: "platform",
		intent: "Report and follow bugs and ideas about MAGI",
		actors: ["CC", "MC"],
		home: "cp-copilot",
		rules: [
			"Search freely; every write (file, comment, close) is a proposal the operator confirms",
			"An issue from a mission is marked as such",
		],
	},
	{
		id: "oversight.alert",
		group: "platform",
		intent: "Sample resources, raise alerts, send the daily report",
		actors: ["PLT"],
		home: "cp-oversight",
		rules: [
			"An alert is raised once per episode, not on every sample",
			"One report per user per day, even across restarts",
		],
	},
	{
		id: "platform.catalog",
		group: "platform",
		intent: "Templates, models and tools on offer",
		actors: ["OP", "CC"],
		home: "cp-api",
		rules: [],
		read: true,
	},
	{
		id: "session.sign-in",
		group: "platform",
		intent: "Start using the cockpit",
		actors: ["OP"],
		home: "cp-edge",
		rules: [],
	},
	{
		id: "session.sign-out",
		group: "platform",
		intent: "Stop using the cockpit",
		actors: ["OP"],
		home: "cp-edge",
		rules: [],
	},
]);
