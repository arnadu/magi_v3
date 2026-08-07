import { useEffect, useState } from "react";
import { fetchCopilotLimits, saveCopilotLimits } from "./data";

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
	const [capUsd, setCapUsd] = useState<number | null>(null);
	const [spentUsd, setSpentUsd] = useState<number | null>(null);
	const [draft, setDraft] = useState<number | undefined>(undefined);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	function load() {
		fetchCopilotLimits().then(
			(d) => {
				setCapUsd(d.capUsd);
				setSpentUsd(d.spentUsd);
				setDraft(d.capUsd ?? undefined);
			},
			() => {
				setCapUsd(null);
				setSpentUsd(null);
			},
		);
	}

	useEffect(load, []);

	async function save(override?: number | null) {
		const value = override === undefined ? (draft ?? null) : override;
		setSaving(true);
		setError(null);
		setNote(null);
		try {
			await saveCopilotLimits(value);
			setNote(
				value ? "Saved." : "Cap cleared — the copilot can spend unbounded.",
			);
			load();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const bar =
		spentUsd != null && capUsd != null ? pctColor(spentUsd, capUsd) : null;

	return (
		<div className="trace-card limits-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Copilot spend cap</h3>
			</div>
			{spentUsd != null && capUsd != null ? (
				<p>
					{fmtUsd(spentUsd)} / {fmtUsd(capUsd)}
					{bar && <Minibar pct={bar.pct} color={bar.color} />}
				</p>
			) : spentUsd != null ? (
				<p>
					{fmtUsd(spentUsd)} spent · <span className="mut">no cap set</span>
				</p>
			) : (
				<p className="mut">Loading…</p>
			)}
			<div className="limits-section">
				<div className="limit-field">
					<span className="limit-field-label">Spend cap ($)</span>
					<input
						type="number"
						className="limit-field-input"
						value={draft ?? ""}
						placeholder="no cap set"
						min={0}
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
					disabled={saving}
					onClick={() => save()}
				>
					{saving ? "Saving…" : "Save cap"}
				</button>
				<button
					type="button"
					className="rail-btn"
					disabled={saving}
					onClick={() => {
						setDraft(undefined);
						save(null);
					}}
				>
					Clear cap
				</button>
			</div>
		</div>
	);
}
