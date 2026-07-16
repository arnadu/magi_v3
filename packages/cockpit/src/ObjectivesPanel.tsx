import { useState } from "react";
import type {
	FoldedKpi,
	FoldedObjective,
	FoldedTask,
	FoldedTree,
} from "./types";

const fmt = (n: number) => `$${n.toFixed(2)}`;
type OnAgent = ((agentId: string) => void) | undefined;

function budgetPct(o: FoldedObjective): { pct: number; color: string } {
	const pct =
		o.budgetUsd > 0
			? Math.min(100, Math.round((100 * o.costUsd) / o.budgetUsd))
			: 0;
	const color =
		pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
	return { pct, color };
}

/** An agent id rendered as a button that opens the chat drawer (or plain text). */
function Agent({
	id,
	prefix,
	className,
	onAgentClick,
}: {
	id: string;
	prefix?: string;
	className: string;
	onAgentClick: OnAgent;
}) {
	const label = `${prefix ?? ""}${id}`;
	if (!onAgentClick) return <span className={className}>{label}</span>;
	return (
		<button
			type="button"
			className={`${className} agent-link`}
			onClick={() => onAgentClick(id)}
			title={`Chat with ${id}`}
		>
			{label}
		</button>
	);
}

function Kpi({
	k,
	onAgentClick,
	filterAgent,
}: {
	k: FoldedKpi;
	onAgentClick: OnAgent;
	filterAgent?: string | null;
}) {
	const v = String(k.value ?? "—");
	const needs = k.stale || /pending|unmet|partial/i.test(v);
	const cls = /pending|unmet/i.test(v)
		? "pill-bad"
		: /partial|left/i.test(v)
			? "pill-part"
			: "pill-ok";
	const dim = !!filterAgent && k.owner !== filterAgent;
	return (
		<span className={`kpi${dim ? " dim" : ""}`} title={`source: ${k.source}`}>
			<span className="ksrc">{k.source.replace("-", " ")}</span>
			<b>{k.label}</b>
			<span className={`kval ${cls}`}>{v}</span>
			{k.kind === "quantitative" && k.target != null && (
				<span className="ktgt">
					/ {k.target}
					{k.unit ? ` ${k.unit}` : ""}
				</span>
			)}
			{needs && <span className="pill-warn">⚠</span>}
			<Agent id={k.owner} className="kown" onAgentClick={onAgentClick} />
		</span>
	);
}

function Task({
	t,
	onAgentClick,
	filterAgent,
}: {
	t: FoldedTask;
	onAgentClick: OnAgent;
	filterAgent?: string | null;
}) {
	const dim = !!filterAgent && t.assignee !== filterAgent;
	return (
		<div className={`task${dim ? " dim" : ""}`}>
			<span className={`s-dot s-${t.status}`} />
			<span className="tid">{t.id}</span>
			<span className="ttl">{t.title}</span>
			<span className="cost">{t.costUsd ? `≈${fmt(t.costUsd)}` : "—"}</span>
			{t.assignee ? (
				<Agent id={t.assignee} className="ass" onAgentClick={onAgentClick} />
			) : (
				<span className="ass">—</span>
			)}
		</div>
	);
}

/** True if this objective, or any task/kpi/child objective under it, belongs to `agent`. */
function objectiveMatches(o: FoldedObjective, agent: string): boolean {
	return (
		o.owner === agent ||
		o.tasks.some((t) => t.assignee === agent) ||
		o.kpis.some((k) => k.owner === agent) ||
		o.children.some((c) => objectiveMatches(c, agent))
	);
}

/** Every distinct owner/assignee id appearing anywhere in the tree, for the filter chips. */
function collectAgents(objectives: FoldedObjective[]): string[] {
	const ids = new Set<string>();
	const walk = (o: FoldedObjective) => {
		ids.add(o.owner);
		for (const t of o.tasks) if (t.assignee) ids.add(t.assignee);
		for (const k of o.kpis) ids.add(k.owner);
		for (const c of o.children) walk(c);
	};
	for (const o of objectives) walk(o);
	return [...ids].sort();
}

function Objective({
	o,
	onAgentClick,
	filterAgent,
}: {
	o: FoldedObjective;
	onAgentClick: OnAgent;
	filterAgent?: string | null;
}) {
	const [open, setOpen] = useState(true);
	const { pct, color } = budgetPct(o);
	// Hide entirely rather than dim: an objective with zero connection to the
	// selected agent (not its owner, no matching task/kpi, no matching
	// descendant) is noise for "what does X own/work on" — dimming still-shown
	// but irrelevant top-level objectives would bury the ones that matter in
	// a mission with many objectives.
	if (filterAgent && !objectiveMatches(o, filterAgent)) return null;
	const dim = !!filterAgent && o.owner !== filterAgent;
	return (
		<div className={`obj ${o.parent ? "sub" : ""}${dim ? " dim" : ""}`}>
			<div className="obj-head">
				<button
					type="button"
					className="obj-toggle"
					onClick={() => setOpen((v) => !v)}
				>
					<span className={`caret ${open ? "" : "closed"}`}>▾</span>
					<span className="status">●</span>
					<span className="obj-title">{o.title}</span>
				</button>
				<Agent
					id={o.owner}
					prefix="owner: "
					className="owner"
					onAgentClick={onAgentClick}
				/>
				<span className="budget">
					${o.budgetUsd.toFixed(2)} · spent <b>≈{fmt(o.costUsd)}</b>
					<span className="minibar">
						<i style={{ width: `${pct}%`, background: color }} />
					</span>
				</span>
			</div>
			{open && (
				<div className="obj-body">
					{o.kpis.length > 0 && (
						<div className="kpis">
							<span className="kpilbl">KPIs</span>
							{o.kpis.map((k) => (
								<Kpi
									key={k.id}
									k={k}
									onAgentClick={onAgentClick}
									filterAgent={filterAgent}
								/>
							))}
						</div>
					)}
					{o.tasks.map((t) => (
						<Task
							key={t.id}
							t={t}
							onAgentClick={onAgentClick}
							filterAgent={filterAgent}
						/>
					))}
					{o.children.map((c) => (
						<Objective
							key={c.id}
							o={c}
							onAgentClick={onAgentClick}
							filterAgent={filterAgent}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export function ObjectivesPanel({
	tree,
	onAgentClick,
}: {
	tree: FoldedTree;
	onAgentClick?: (agentId: string) => void;
}) {
	const roots = tree.objectives.filter((o) => o.parent === null);
	const [filterAgent, setFilterAgent] = useState<string | null>(null);
	const agentIds = collectAgents(tree.objectives);
	return (
		<div className="panel">
			<h2 className="sec">Objectives</h2>
			{agentIds.length > 1 && (
				<div className="obj-filter">
					<span className="kpilbl">Filter</span>
					{agentIds.map((id) => (
						<button
							type="button"
							key={id}
							className={`chip${filterAgent === id ? " on" : ""}`}
							onClick={() => setFilterAgent((cur) => (cur === id ? null : id))}
						>
							{id}
						</button>
					))}
				</div>
			)}
			{roots.map((o) => (
				<Objective
					key={o.id}
					o={o}
					onAgentClick={onAgentClick}
					filterAgent={filterAgent}
				/>
			))}
			{filterAgent && roots.every((o) => !objectiveMatches(o, filterAgent)) && (
				<p className="mut">No objectives, tasks, or KPIs for {filterAgent}.</p>
			)}
			{tree.overheadCostUsd > 0 && (
				<p className="mut">
					Unattributed / overhead: ≈{fmt(tree.overheadCostUsd)}
				</p>
			)}
		</div>
	);
}
