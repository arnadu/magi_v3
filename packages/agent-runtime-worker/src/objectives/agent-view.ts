/**
 * Agent view of the objectives store (Sprint 26a, deliverable B1).
 *
 * Renders the inner HTML of the daemon-managed `#my-objectives` mental-map
 * section for one agent: the objectives it owns, the KPIs it owns (with
 * freshness), and the open tasks assigned to it. This is the *bridge* — the
 * agent reads its accountability from working memory and acts via the skill
 * scripts. The store is the source of truth; this section is regenerated every
 * turn and is read-only to the agent.
 */

import type { FoldedObjective, FoldedTree } from "./types.js";

/** The mental-map section id the daemon owns and the agent may not edit. */
export const MY_OBJECTIVES_ID = "my-objectives";

function esc(s: string): string {
	return s.replace(
		/[&<>]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string,
	);
}

function flatten(roots: FoldedObjective[]): FoldedObjective[] {
	const out: FoldedObjective[] = [];
	const walk = (o: FoldedObjective) => {
		out.push(o);
		for (const c of o.children) walk(c);
	};
	for (const r of roots) walk(r);
	return out;
}

const OPEN_TASK = (s: string) => s !== "completed" && s !== "cancelled";

/**
 * Build the inner HTML for the agent's `#my-objectives` section, or `null` when
 * the mission has no objectives store at all (so the section is not injected for
 * missions that don't use the objectives system).
 */
export function renderMyObjectives(
	tree: FoldedTree,
	agentId: string,
): string | null {
	if (tree.objectives.length === 0 && tree.tasks.length === 0) return null;

	const all = flatten(tree.objectives);
	const ownedObjs = all.filter((o) => o.owner === agentId);
	const myKpis = all.flatMap((o) =>
		o.kpis.filter((k) => k.owner === agentId).map((k) => ({ k, objId: o.id })),
	);
	const myTasks = tree.tasks.filter(
		(t) => t.assignee === agentId && OPEN_TASK(t.status),
	);

	const parts: string[] = [
		"<h3>Your objectives</h3>",
		"<p><em>Synced from the objectives store — read-only. Update via the objectives skill scripts.</em></p>",
	];

	for (const o of ownedObjs) {
		const spent = o.costUsd > 0 ? `, spent ≈$${o.costUsd.toFixed(2)}` : "";
		const budget = o.budgetUsd > 0 ? `, budget $${o.budgetUsd.toFixed(2)}` : "";
		parts.push(
			`<p>You own objective <strong>${o.id}</strong> "${esc(o.title)}" (${o.status}${budget}${spent}).</p>`,
		);
	}

	if (myKpis.length > 0) {
		const items = myKpis
			.map(({ k, objId }) => {
				const val =
					k.value === null ? "not yet reported" : esc(String(k.value));
				const tgt =
					k.target != null
						? ` / ${k.target}${k.unit ? ` ${esc(k.unit)}` : ""}`
						: "";
				const flag = k.stale
					? ` — ⚠ needs update, run <code>record-kpi --kpi ${k.id} --value …</code>`
					: "";
				return `<li>KPI <strong>${k.id}</strong> "${esc(k.label)}" [${objId}] = ${val}${tgt}${flag}</li>`;
			})
			.join("");
		parts.push(`<p>KPIs you own:</p><ul>${items}</ul>`);
	}

	if (myTasks.length > 0) {
		const items = myTasks
			.map((t) => {
				const objRef = t.objective ? ` [${t.objective}]` : "";
				return `<li><strong>${t.id}</strong> ${esc(t.title)} — ${t.status}${objRef}</li>`;
			})
			.join("");
		parts.push(
			`<p>Your open tasks (update with <code>task-update</code>):</p><ul>${items}</ul>`,
		);
	} else {
		parts.push("<p>No open tasks are assigned to you.</p>");
	}

	return parts.join("\n");
}
