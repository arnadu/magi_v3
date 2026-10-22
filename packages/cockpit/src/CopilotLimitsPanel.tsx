import { useEffect, useState } from "react";
import {
	type CopilotLimits,
	fetchCopilotLimits,
	saveCopilotLimits,
} from "./data";

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** Same 90/70 threshold + color convention as LimitsPanel.tsx's pctColor —
 * duplicated rather than imported, per that file's own note: it's a 6-line
 * pure function, not worth a cross-panel dependency. */
function pctColor(spent: number, cap: number): { pct: number; color: string } {
	const pct = cap > 0 ? Math.min(100, Math.round((100 * spent) / cap)) : 0;
	const color =
		pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--ok)";
	return { pct, color };
}

function Minibar({ pct, color }: { pct: number; color: string }) {
	return (
		<span className="minibar">
			<i style={{ width: `${pct}%`, background: color }} />
		</span>
	);
}

export function CopilotLimitsPanel() {
	const [limits, setLimits] = useState<CopilotLimits | null>(null);
	const [draft, setDraft] = useState<number | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	function load() {
		fetchCopilotLimits().then(
			(d) => {
				setLimits(d);
				setDraft(d.capUsd);
			},
			(e: Error) => {
				setLimits(null);
				setError(`Could not load the copilot's limits: ${e.message}`);
			},
		);
	}

	useEffect(load, []);

	/** A number sets the cap; null resets it to the default — the copilot always has a cap. */
	async function save(value: number | null) {
		setSaving(true);
		setError(null);
		setNote(null);
		try {
			await saveCopilotLimits(value);
			setNote(value === null ? "Reset to the default cap." : "Saved.");
			load();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const bar = limits ? pctColor(limits.spentUsd, limits.capUsd) : null;
	const draftValid = draft !== undefined && Number.isFinite(draft) && draft > 0;

	return (
		<div className="trace-card limits-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Copilot spend cap</h3>
			</div>
			{limits ? (
				<p>
					{fmtUsd(limits.spentUsd)} / {fmtUsd(limits.capUsd)}
					{limits.isDefault && <span className="mut"> (default)</span>}
					{bar && <Minibar pct={bar.pct} color={bar.color} />}
				</p>
			) : (
				!error && <p className="mut">Loading…</p>
			)}
			{limits && (
				<p className="mut">
					When the cap is reached the copilot stops — mid-turn if need be —
					until you raise it. A single turn is also stopped after{" "}
					{limits.maxTurnMinutes} minutes.
					{limits.ceilingUsd !== null &&
						` You can set a cap up to ${fmtUsd(limits.ceilingUsd)}; a platform admin can go higher.`}
				</p>
			)}
			<div className="limits-section">
				<div className="limit-field">
					<span className="limit-field-label">Spend cap ($)</span>
					<input
						type="number"
						className="limit-field-input"
						value={draft ?? ""}
						min={0}
						max={limits?.ceilingUsd ?? undefined}
						onChange={(e) => {
							const raw = e.target.value;
							setDraft(raw === "" ? undefined : Number(raw));
						}}
					/>
				</div>
			</div>
			{error && <p className="mut limits-error">{error}</p>}
			{note && <p className="mut">{note}</p>}
			<div className="limits-actions">
				<button
					type="button"
					className="rail-btn"
					disabled={saving || !draftValid}
					onClick={() => draftValid && save(draft)}
				>
					{saving ? "Saving…" : "Save cap"}
				</button>
				<button
					type="button"
					className="rail-btn"
					disabled={saving || limits?.isDefault}
					onClick={() => save(null)}
				>
					Reset to default
					{limits ? ` (${fmtUsd(limits.defaultCapUsd)})` : ""}
				</button>
			</div>
		</div>
	);
}
