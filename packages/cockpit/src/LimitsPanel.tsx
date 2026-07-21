import { useEffect, useState } from "react";
import type { AgentLimits, AgentLimitsRow, LimitsData } from "./data";
import { fetchLimits, saveAgentLimits, saveMissionCap } from "./data";

const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** Same 90/70 threshold + color convention as ObjectivesPanel's budgetPct() —
 * duplicated rather than imported: it's a 6-line pure function, and pulling
 * in a cross-panel dependency for something this small isn't worth it unless
 * a third consumer shows up. */
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

const HARD_FIELDS = [
	{
		key: "maxLlmCallsPerTurn" as const,
		label: "Max LLM calls / turn",
		unit: "calls",
	},
	{
		key: "maxCostPerTurnUsd" as const,
		label: "Max cost / turn",
		unit: "$",
	},
	{
		key: "maxLifetimeCostUsd" as const,
		label: "Max lifetime cost",
		unit: "$",
	},
];

const SOFT_FIELDS = [
	{
		key: "warnLlmCallsPerTurn" as const,
		label: "Warn: LLM calls / turn",
	},
	{
		key: "warnPeakContextTokens" as const,
		label: "Warn: peak context tokens",
	},
	{
		key: "warnToolErrorsPerTurn" as const,
		label: "Warn: tool errors / turn",
	},
	{
		key: "warnConsecutiveZeroOutputTurns" as const,
		label: "Warn: consecutive zero-output turns",
	},
];

/** A single numeric limit field — label, current live value (if any), an
 * editable input, and (for soft fields) a configured-vs-default annotation. */
function LimitField({
	label,
	value,
	onChange,
	liveNote,
	annotation,
}: {
	label: string;
	value: number | undefined;
	onChange: (v: number | undefined) => void;
	liveNote?: string;
	annotation?: string;
}) {
	return (
		<div className="limit-field">
			<span className="limit-field-label">{label}</span>
			<input
				type="number"
				className="limit-field-input"
				value={value ?? ""}
				placeholder="no cap set"
				min={0}
				onChange={(e) => {
					const raw = e.target.value;
					onChange(raw === "" ? undefined : Number(raw));
				}}
			/>
			{annotation && <span className="mut limit-field-note">{annotation}</span>}
			{liveNote && <span className="mut limit-field-note">{liveNote}</span>}
		</div>
	);
}

function AgentCard({
	row,
	missionId,
	onSaved,
}: {
	row: AgentLimitsRow;
	missionId: string;
	onSaved: () => void;
}) {
	const [draft, setDraft] = useState<AgentLimits>(row.limits);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const set = (key: keyof AgentLimits, v: number | undefined) =>
		setDraft((d) => ({ ...d, [key]: v }));

	async function save(next: AgentLimits | null) {
		setSaving(true);
		setError(null);
		try {
			await saveAgentLimits(missionId, row.agentId, next);
			onSaved();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const mrt = row.live.mostRecentTurn;

	return (
		<div className="trace-card limits-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">{row.agentId}</h3>
				{row.live.lifetimeCostUsd != null && (
					<span className="mut">
						lifetime {fmtUsd(row.live.lifetimeCostUsd)}
						{row.live.lifetimeLlmCallCount != null &&
							` · ${row.live.lifetimeLlmCallCount} calls`}
					</span>
				)}
			</div>

			<div className="limits-section">
				<span className="kpilbl">Hard limits</span>
				{HARD_FIELDS.map((f) => {
					let liveNote: string | undefined;
					if (
						f.key === "maxLifetimeCostUsd" &&
						row.live.lifetimeCostUsd != null
					) {
						liveNote = `lifetime so far: ${fmtUsd(row.live.lifetimeCostUsd)}`;
					} else if (f.key === "maxCostPerTurnUsd" && mrt) {
						liveNote = `most recent turn: ${fmtUsd(mrt.costUsd)}`;
					} else if (f.key === "maxLlmCallsPerTurn" && mrt) {
						liveNote = `most recent turn: ${mrt.llmCallCount} calls`;
					}
					return (
						<LimitField
							key={f.key}
							label={f.label}
							value={draft[f.key]}
							onChange={(v) => set(f.key, v)}
							liveNote={liveNote}
						/>
					);
				})}
			</div>

			<div className="limits-section">
				<span className="kpilbl">
					Soft limits (advisory — never block a turn)
				</span>
				{SOFT_FIELDS.map((f) => {
					const configured = row.limits[f.key] !== undefined;
					const isDisabled = row.limits[f.key] === 0;
					let liveNote: string | undefined;
					if (f.key === "warnPeakContextTokens" && mrt) {
						liveNote = `most recent turn: ${mrt.peakContextTokens.toLocaleString()} tokens`;
					} else if (f.key === "warnToolErrorsPerTurn" && mrt) {
						liveNote = `most recent turn: ${mrt.toolErrorsTotal} errors`;
					} else if (f.key === "warnLlmCallsPerTurn" && mrt) {
						liveNote = `most recent turn: ${mrt.llmCallCount} calls`;
					} else if (
						f.key === "warnConsecutiveZeroOutputTurns" &&
						row.live.consecutiveZeroOutputTurns != null
					) {
						liveNote = `currently: ${row.live.consecutiveZeroOutputTurns}`;
					}
					return (
						<LimitField
							key={f.key}
							label={f.label}
							value={draft[f.key]}
							onChange={(v) => set(f.key, v)}
							liveNote={liveNote}
							annotation={
								isDisabled
									? "(disabled)"
									: configured
										? "(configured)"
										: `(built-in default: ${row.effectiveSoft[f.key]})`
							}
						/>
					);
				})}
			</div>

			{error && <p className="mut limits-error">{error}</p>}
			<div className="limits-actions">
				<button
					type="button"
					className="rail-btn"
					disabled={saving}
					onClick={() => save(draft)}
				>
					{saving ? "Saving…" : "Save limits"}
				</button>
				<button
					type="button"
					className="rail-btn"
					disabled={saving}
					onClick={() => {
						setDraft({});
						save(null);
					}}
				>
					Clear all limits
				</button>
			</div>
		</div>
	);
}

function MissionSection({
	data,
	missionId,
	onSaved,
}: {
	data: LimitsData;
	missionId: string;
	onSaved: () => void;
}) {
	const [draft, setDraft] = useState<number | undefined>(
		data.mission.maxCostUsd ?? undefined,
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);

	async function save() {
		if (draft === undefined || draft <= 0) {
			setError("Enter a positive amount.");
			return;
		}
		setSaving(true);
		setError(null);
		setNote(null);
		try {
			const res = await saveMissionCap(missionId, draft);
			setNote(
				res.liveUpdateApplied
					? "Saved — applied immediately."
					: "Saved — will apply on the mission's next spend check, or the next resume if suspended.",
			);
			onSaved();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	const { missionTotalUsd, maxCostUsd, budgetPaused } = data.mission;
	const bar =
		missionTotalUsd != null && maxCostUsd != null
			? pctColor(missionTotalUsd, maxCostUsd)
			: null;

	return (
		<div className="trace-card limits-card">
			<div className="trace-card-head">
				<h3 className="trace-card-title">Mission spend cap</h3>
				{budgetPaused && (
					<span className="badge badge-bad">⏸ budget paused</span>
				)}
			</div>
			{missionTotalUsd != null && maxCostUsd != null ? (
				<p>
					{fmtUsd(missionTotalUsd)} / {fmtUsd(maxCostUsd)}
					{bar && <Minibar pct={bar.pct} color={bar.color} />}
				</p>
			) : maxCostUsd != null ? (
				<p>
					Cap: {fmtUsd(maxCostUsd)}.{" "}
					<span className="mut">
						{data.missionRunning
							? "Current spend unavailable."
							: "Mission is not running — current spend unavailable."}
					</span>
				</p>
			) : (
				<p className="mut">
					No spend cap set — this mission can run unbounded.
				</p>
			)}
			<div className="limits-section">
				<LimitField label="Spend cap ($)" value={draft} onChange={setDraft} />
			</div>
			{error && <p className="mut limits-error">{error}</p>}
			{note && <p className="mut">{note}</p>}
			<div className="limits-actions">
				<button
					type="button"
					className="rail-btn"
					disabled={saving}
					onClick={save}
				>
					{saving ? "Saving…" : "Save cap"}
				</button>
			</div>
		</div>
	);
}

export function LimitsPanel({ missionId }: { missionId: string | null }) {
	const [data, setData] = useState<LimitsData | null | "error">(null);
	const [refreshKey, setRefreshKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a signal-only dependency (re-fetch on save/refresh), not read in the body
	useEffect(() => {
		if (!missionId) return;
		setData(null);
		fetchLimits(missionId).then(setData, () => setData("error"));
	}, [missionId, refreshKey]);

	if (!missionId)
		return <p className="mut">Select a live mission to see its limits.</p>;
	if (data === "error")
		return <p className="mut">Could not load limits for this mission.</p>;
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
			<MissionSection
				data={data}
				missionId={missionId}
				onSaved={() => setRefreshKey((k) => k + 1)}
			/>
			{data.agents.map((row) => (
				<AgentCard
					key={row.agentId}
					row={row}
					missionId={missionId}
					onSaved={() => setRefreshKey((k) => k + 1)}
				/>
			))}
		</div>
	);
}
