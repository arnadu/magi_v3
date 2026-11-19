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
		id: "copilot.confirm",
		group: "copilot",
		intent: "Accept a copilot's proposal",
		actors: ["OP"],
		home: "cp-copilot",
		rules: [
			"Carried out once, even if confirmed twice",
			"Validated against the action's schema when proposed and again when carried out; the label the operator sees is written by the server",
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
			"CC receives the platform's reports and alerts; MC those about its mission",
		],
	},
	{
		id: "platform.offerings",
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
