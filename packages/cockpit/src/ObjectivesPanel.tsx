import { useState } from "react";
import type {
	FoldedKpi,
	FoldedObjective,
	FoldedTask,
	FoldedTree,
} from "./types";

const fmt = (n: number) => `$${n.toFixed(2)}`;

function budgetPct(o: FoldedObjective): { pct: number; color: string } {
	const pct =
		o.budgetUsd > 0
			? Math.min(100, Math.round((100 * o.costUsd) / o.budgetUsd))
			: 0;
	const color =
		pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
	return { pct, color };
}

function Kpi({ k }: { k: FoldedKpi }) {
	const v = String(k.value ?? "—");
	const needs = k.stale || /pending|unmet|partial/i.test(v);
	const cls = /pending|unmet/i.test(v)
		? "pill-bad"
		: /partial|left/i.test(v)
			? "pill-part"
			: "pill-ok";
	return (
		<span className="kpi" title={`source: ${k.source}`}>
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
			<span className="kown">{k.owner}</span>
		</span>
	);
}

function Task({ t }: { t: FoldedTask }) {
	return (
		<div className="task">
			<span className={`s-dot s-${t.status}`} />
			<span className="tid">{t.id}</span>
			<span className="ttl">{t.title}</span>
			<span className="cost">{t.costUsd ? `≈${fmt(t.costUsd)}` : "—"}</span>
			<span className="ass">{t.assignee ?? "—"}</span>
		</div>
	);
}

function Objective({ o }: { o: FoldedObjective }) {
	const [open, setOpen] = useState(true);
	const { pct, color } = budgetPct(o);
	return (
		<div className={`obj ${o.parent ? "sub" : ""}`}>
			<button
				type="button"
				className="obj-head"
				onClick={() => setOpen((v) => !v)}
			>
				<span className={`caret ${open ? "" : "closed"}`}>▾</span>
				<span className="status">●</span>
				<span className="obj-title">{o.title}</span>
				<span className="owner">owner: {o.owner}</span>
				<span className="budget">
					${o.budgetUsd.toFixed(2)} · spent <b>≈{fmt(o.costUsd)}</b>
					<span className="minibar">
						<i style={{ width: `${pct}%`, background: color }} />
					</span>
				</span>
			</button>
			{open && (
				<div className="obj-body">
					{o.kpis.length > 0 && (
						<div className="kpis">
							<span className="kpilbl">KPIs</span>
							{o.kpis.map((k) => (
								<Kpi key={k.id} k={k} />
							))}
						</div>
					)}
					{o.tasks.map((t) => (
						<Task key={t.id} t={t} />
					))}
					{o.children.map((c) => (
						<Objective key={c.id} o={c} />
					))}
				</div>
			)}
		</div>
	);
}

export function ObjectivesPanel({ tree }: { tree: FoldedTree }) {
	const roots = tree.objectives.filter((o) => o.parent === null);
	return (
		<div className="panel">
			<h2 className="sec">Objectives</h2>
			{roots.map((o) => (
				<Objective key={o.id} o={o} />
			))}
			{tree.overheadCostUsd > 0 && (
				<p className="mut">
					Unattributed / overhead: ≈{fmt(tree.overheadCostUsd)}
				</p>
			)}
		</div>
	);
}
