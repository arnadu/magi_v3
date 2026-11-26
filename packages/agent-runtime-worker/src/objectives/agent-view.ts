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

import type { FoldedObjective, FoldedTask, FoldedTree } from "./types.js";

/**
 * The `data-managed` key for the daemon-owned objectives region. It carries no
 * `id`, so the agent's id-only mental-map tools cannot reach it — protected by
 * the same rule as non-id'd structure.
 */
export const MY_OBJECTIVES_KEY = "my-objectives";

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
 * One task: its title, and for a task being worked on its work order. A
 * deferred task shows only its title, to keep the map short.
 */
function renderTask(t: FoldedTask): string {
	const objRef = t.objective ? ` [${t.objective}]` : "";
	const head = `<strong>${t.id}</strong> ${esc(t.title)} — ${t.status}${objRef}`;
	if (t.status === "deferred") return `<li>${head}</li>`;
	const lines: string[] = [];
	if (t.instructions) lines.push(`Instructions: ${esc(t.instructions)}`);
	if (t.doneWhen) lines.push(`Done when: ${esc(t.doneWhen)}`);
	if (t.check) lines.push(`Checked by: <code>${esc(t.check.script)}</code>`);
	if (t.skills?.length)
		lines.push(`Must follow skills: ${t.skills.map(esc).join(", ")}`);
	if (lines.length === 0) return `<li>${head}</li>`;
	return `<li>${head}<br>${lines.join("<br>")}</li>`;
}

/**
 * Build the inner HTML for the agent's `#my-objectives` section, or `null` when
 * the mission has no objectives store at all (so the section is not injected for
 * missions that don't use the objectives system).
 */
export interface MyObjectivesOpts {
	/**
	 * Turns since the agent last had cost attributed. When at/over the staleness
	 * threshold, a nudge to run `allocate` is shown (B2b).
	 */
	staleAttributionTurns?: number;
	/** The staleness threshold (defaults match the attribution module). */
	staleThreshold?: number;
}

export function renderMyObjectives(
	tree: FoldedTree,
	agentId: string,
	opts: MyObjectivesOpts = {},
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
		"<p><em>Synced from the objectives store — read-only. Update it with the AddTask, UpdateTask, RecordKpi and Allocate tools.</em></p>",
	];

	for (const o of ownedObjs) {
		const spent = o.costUsd > 0 ? `, spent ≈$${o.costUsd.toFixed(2)}` : "";
		const budget = o.budgetUsd > 0 ? `, budget $${o.budgetUsd.toFixed(2)}` : "";
		parts.push(
			`<p>You own objective <strong>${o.id}</strong> "${esc(o.title)}" (${o.status}${budget}${spent}).</p>`,
		);
		if (o.description) parts.push(`<p>${esc(o.description)}</p>`);
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
					? ` — ⚠ needs update, call <code>RecordKpi</code> with kpi "${k.id}"`
					: "";
				return `<li>KPI <strong>${k.id}</strong> "${esc(k.label)}" [${objId}] = ${val}${tgt}${flag}</li>`;
			})
			.join("");
		parts.push(`<p>KPIs you own:</p><ul>${items}</ul>`);
	}

	if (myTasks.length > 0) {
		const items = myTasks.map(renderTask).join("");
		parts.push(
			`<p>Your open tasks (update with <code>UpdateTask</code>). Starting one (in-progress) gives you the skills it must follow; completing one needs its finish line met: its check passes, or your note says how each condition was met.</p><ul>${items}</ul>`,
		);
	} else {
		parts.push("<p>No open tasks are assigned to you.</p>");
	}

	const threshold = opts.staleThreshold ?? 3;
	if ((opts.staleAttributionTurns ?? 0) >= threshold) {
		parts.push(
			`<p>⚠ You have unattributed cost over ${opts.staleAttributionTurns} turns. Attribute it by calling <code>UpdateTask</code> with an <code>effort</code>, or <code>Allocate</code> with a key such as "TASK-x:60,overhead:40".</p>`,
		);
	}

	return parts.join("\n");
}
