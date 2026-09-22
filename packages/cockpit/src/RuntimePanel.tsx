import { useEffect, useState } from "react";
import type { MachineRuntimeData, MachineRuntimeRow } from "./data";
import { fetchMachineRuntime } from "./data";

const HORIZONS: Array<{
	key: keyof MachineRuntimeData["byHorizon"];
	label: string;
}> = [
	{ key: "today", label: "Today" },
	{ key: "7d", label: "Last 7 days" },
	{ key: "30d", label: "Last 30 days" },
	{ key: "lifetime", label: "Lifetime" },
];

export function fmtHours(ms: number): string {
	const h = ms / 3_600_000;
	return h < 10 ? h.toFixed(1) : String(Math.round(h));
}

export function fmtShape(shape: {
	cpuKind: string;
	cpus: number;
	memoryMb: number;
}): string {
	const gb = shape.memoryMb / 1024;
	const gbText = Number.isInteger(gb) ? String(gb) : gb.toFixed(1);
	return `${shape.cpuKind}, ${shape.cpus} CPU${shape.cpus === 1 ? "" : "s"}, ${gbText} GB`;
}

export function fmtUsd(n: number): string {
	return n < 1 ? `~$${n.toFixed(2)}` : `~$${n.toFixed(0)}`;
}

export function shapeKey(shape: MachineRuntimeRow["shape"]): string {
	return `${shape.cpuKind}/${shape.cpus}/${shape.memoryMb}`;
}

function HorizonSection({
	label,
	rows,
}: {
	label: string;
	rows: MachineRuntimeRow[];
}) {
	const sorted = [...rows].sort((a, b) => b.ms - a.ms);
	const totalMs = rows.reduce((sum, r) => sum + r.ms, 0);
	const totalCost = rows.reduce((sum, r) => sum + r.estimatedCostUsd, 0);

	return (
		<div className="trace-card limits-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">{label}</h3>
				{totalMs > 0 && (
					<span className="mut">
						{fmtHours(totalMs)}h total · {fmtUsd(totalCost)} estimated
					</span>
				)}
			</div>
			{sorted.length === 0 ? (
				<p className="mut">No machine runtime recorded in this window.</p>
			) : (
				<div className="runtime-rows">
					<div className="runtime-row runtime-row-head mut">
						<span>Machine config</span>
						<span>Time</span>
						<span>Est. cost</span>
					</div>
					{sorted.map((row) => (
						<div className="runtime-row" key={shapeKey(row.shape)}>
							<span>
								{fmtShape(row.shape)}
								{row.upgraded && (
									<span className="badge badge-warn" style={{ marginLeft: 6 }}>
										upgraded
									</span>
								)}
							</span>
							<span>{fmtHours(row.ms)}h</span>
							<span className="mut">{fmtUsd(row.estimatedCostUsd)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** Wall-clock machine time by shape (ADR-0031 Decision 1) — deliberately
 * separate from the Limits tab's $ spend cap. The estimated-cost figure is
 * display-only, computed server-side from a maintained Fly price table, and
 * never used for any enforcement. */
export function RuntimePanel({ missionId }: { missionId: string | null }) {
	const [data, setData] = useState<MachineRuntimeData | null | "error">(null);
	const [refreshKey, setRefreshKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a signal-only dependency (re-fetch on refresh), not read in the body
	useEffect(() => {
		if (!missionId) return;
		setData(null);
		fetchMachineRuntime(missionId).then(setData, () => setData("error"));
	}, [missionId, refreshKey]);

	if (!missionId)
		return <p className="mut">Select a live mission to see its runtime.</p>;
	if (data === "error")
		return <p className="mut">Could not load runtime data for this mission.</p>;
	if (data === null) return <p className="mut">Loading…</p>;

	return (
		<div className="limits">
			<div className="trace-card-head" style={{ marginBottom: 4 }}>
				<span className="grow" />
				<button
					type="button"
					className="rail-btn"
					onClick={() => setRefreshKey((k) => k + 1)}
				>
					Refresh
				</button>
			</div>
			<p className="mut">
				Wall-clock machine time by configuration, not dollars spent on LLM calls
				— see the Limits tab for the spend cap. Estimated cost is a display-only
				figure from a maintained Fly price table.
			</p>
			{HORIZONS.map(({ key, label }) => (
				<HorizonSection
					key={key}
					label={label}
					rows={data.byHorizon[key] ?? []}
				/>
			))}
		</div>
	);
}
