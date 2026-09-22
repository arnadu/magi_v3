import { useState } from "react";
import type { LimitsData } from "./data";
import { resetUpgradedRuntime } from "./data";
import { Minibar, pctColor } from "./LimitsPanel";

export function fmtHours(h: number): string {
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

/** ADR-0031 Decision 7 — the 24h cumulative upgraded-machine-runtime cap,
 * shown alongside the $ spend cap and its ceiling but deliberately not part
 * of either: this counts wall-clock time, never dollars. */
export function UpgradeLimitsSection({
	data,
	missionId,
	onSaved,
}: {
	data: LimitsData;
	missionId: string;
	onSaved: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const { usedHours, capHours, resetAt, active } = data.upgrades;
	const bar = pctColor(usedHours, capHours);

	async function doReset() {
		setResetting(true);
		setError(null);
		setNote(null);
		try {
			const res = await resetUpgradedRuntime(missionId);
			setNote(`Reset to 0h at ${new Date(res.resetAt).toLocaleString()}.`);
			setConfirming(false);
			onSaved();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setResetting(false);
		}
	}

	return (
		<div className="trace-card limits-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Upgraded compute time</h3>
				{active && <span className="badge badge-warn">upgraded now</span>}
			</div>
			<p>
				{fmtHours(usedHours)}h / {capHours}h used
				<Minibar pct={bar.pct} color={bar.color} />
			</p>
			<p className="mut">
				{resetAt
					? `Counting since the operator last reset it, ${new Date(resetAt).toLocaleString()}.`
					: "Counting since this mission was created — never reset."}{" "}
				Reaching the cap blocks new upgrade requests until reset here.
			</p>
			{active ? (
				<p>
					Active: {fmtShape(active)}, expires{" "}
					{new Date(active.expiresAt).toLocaleString()}
					{active.requestedByAgentId &&
						` — requested by ${active.requestedByAgentId}`}
				</p>
			) : (
				<p className="mut">Currently on the mission's default machine.</p>
			)}
			{error && <p className="mut limits-error">{error}</p>}
			{note && <p className="mut">{note}</p>}
			<div className="limits-actions">
				{confirming ? (
					<>
						<span className="mut">
							Reset the {fmtHours(usedHours)}h counter to 0h?
						</span>
						<button
							type="button"
							className="rail-btn"
							disabled={resetting}
							onClick={doReset}
						>
							{resetting ? "Resetting…" : "Confirm reset"}
						</button>
						<button
							type="button"
							className="rail-btn"
							disabled={resetting}
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
					</>
				) : (
					<button
						type="button"
						className="rail-btn"
						onClick={() => setConfirming(true)}
					>
						Reset counter
					</button>
				)}
			</div>
		</div>
	);
}
