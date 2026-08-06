import { useEffect, useState } from "react";
import {
	createMission,
	deleteMission,
	fetchMissionsStats,
	fetchTemplates,
	type MissionStatsEntry,
	type MissionStatusValue,
	type MissionSummary,
	resumeMission,
	suspendMission,
	type TemplateSummary,
} from "./data";

/** Relative-time formatting for "last activity" — matches index.html's relativeTime(). */
function relativeTime(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const min = Math.round(diffMs / 60_000);
	if (min < 1) return "just now";
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.round(hr / 24)}d ago`;
}

const STATUS_LABEL: Record<MissionStatusValue, string> = {
	provisioning: "provisioning",
	running: "running",
	suspended: "suspended",
	destroyed: "destroyed",
	error: "error",
};

function StatusBadge({ status }: { status: MissionStatusValue }) {
	return (
		<span className={`mission-status mission-status-${status}`}>
			{STATUS_LABEL[status]}
		</span>
	);
}

/** Derives a URL-safe missionId slug from a mission name, e.g. "Q3 Report " -> "q3-report". */
function slugify(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "mission"
	);
}

function CreateMissionForm({
	onClose,
	onCreated,
	initialTemplateId,
}: {
	onClose: () => void;
	onCreated: (missionId: string) => void;
	initialTemplateId?: string | null;
}) {
	const [templates, setTemplates] = useState<
		TemplateSummary[] | "error" | null
	>(null);
	const [templateId, setTemplateId] = useState(initialTemplateId ?? "");
	const [name, setName] = useState("");
	const [missionIdTouched, setMissionIdTouched] = useState(false);
	const [missionId, setMissionId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchTemplates()
			.then((t) => {
				if (cancelled) return;
				setTemplates(t);
				// Keep the pre-selected template (arrived via a Templates panel
				// "Launch" action) if it still exists; otherwise fall back to the
				// first available one.
				if (
					initialTemplateId &&
					t.some((tpl) => tpl.id === initialTemplateId)
				) {
					setTemplateId(initialTemplateId);
				} else if (t.length > 0) {
					setTemplateId(t[0].id);
				}
			})
			.catch(() => {
				if (!cancelled) setTemplates("error");
			});
		return () => {
			cancelled = true;
		};
	}, [initialTemplateId]);

	async function handleCreate() {
		if (!templateId) {
			setError("Choose a template.");
			return;
		}
		if (!name.trim()) {
			setError("Enter a mission name.");
			return;
		}
		const id = missionId.trim() || slugify(name);
		setBusy(true);
		setError(null);
		try {
			await createMission(id, name.trim(), templateId);
			onCreated(id);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="create-mission-box">
			<div className="create-mission-row">
				<label htmlFor="new-mission-template">Template</label>
				{templates === null && <span className="mut">Loading templates…</span>}
				{templates === "error" && (
					<span className="error-msg">Could not load templates.</span>
				)}
				{Array.isArray(templates) && (
					<select
						id="new-mission-template"
						value={templateId}
						onChange={(e) => setTemplateId(e.target.value)}
					>
						{templates.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))}
					</select>
				)}
			</div>
			<div className="create-mission-row">
				<label htmlFor="new-mission-name">Name</label>
				<input
					id="new-mission-name"
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						if (!missionIdTouched) setMissionId(slugify(e.target.value));
					}}
					placeholder="e.g. Q3 Sector Report"
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="new-mission-id">Mission ID</label>
				<input
					id="new-mission-id"
					value={missionId}
					onChange={(e) => {
						setMissionIdTouched(true);
						setMissionId(e.target.value);
					}}
					placeholder="auto-derived from name"
				/>
			</div>
			{error && <p className="error-msg">{error}</p>}
			<div className="create-mission-actions">
				<button
					type="button"
					className="btn-primary"
					disabled={busy || !Array.isArray(templates)}
					onClick={handleCreate}
				>
					{busy ? "Launching…" : "Launch"}
				</button>
				<button
					type="button"
					className="rail-btn"
					disabled={busy}
					onClick={onClose}
				>
					Cancel
				</button>
			</div>
		</div>
	);
}

function StatsLine({
	s,
	maxCostUsd,
}: {
	s: MissionStatsEntry;
	maxCostUsd?: number | null;
}) {
	const room = maxCostUsd != null ? maxCostUsd - s.spendTotal : null;
	return (
		<div className="mission-row-stats mut">
			<span>${s.spendLastHour.toFixed(3)}/hr</span>
			<span>${s.spendToday.toFixed(3)} today</span>
			{maxCostUsd != null ? (
				<span
					className={
						room != null && room <= 0 ? "mission-room-over" : undefined
					}
				>
					${s.spendTotal.toFixed(2)} / ${maxCostUsd.toFixed(2)} cap
					{room != null && ` — $${room.toFixed(2)} left`}
				</span>
			) : (
				<span>${s.spendTotal.toFixed(2)} total (no cap set)</span>
			)}
			{s.lastActivity && <span>active {relativeTime(s.lastActivity)}</span>}
			{s.snippet && <span className="mission-snippet">{s.snippet}</span>}
		</div>
	);
}

export function MissionsPanel({
	missions,
	onRefresh,
	initialTemplateId,
}: {
	missions: MissionSummary[];
	onRefresh: () => void;
	/** Pre-selects a template and opens the create form — set when arriving via a Templates panel "Launch" action. */
	initialTemplateId?: string | null;
}) {
	const [creating, setCreating] = useState(!!initialTemplateId);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [confirmDestroyId, setConfirmDestroyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stats, setStats] = useState<Record<string, MissionStatsEntry>>({});

	// Ported from index.html's Active Sessions cards (unread/spend/last-activity/
	// snippet) — refetches whenever the mission list itself refreshes (a new
	// array reference from the parent), same cadence the old dashboard used.
	// biome-ignore lint/correctness/useExhaustiveDependencies: missions is a deliberate refetch trigger (new array reference from the parent), not read inside the effect
	useEffect(() => {
		let cancelled = false;
		fetchMissionsStats()
			.then((s) => {
				if (!cancelled) setStats(s);
			})
			.catch(() => {
				// Stats are supplementary — a failed fetch just leaves rows without
				// the extra line, not an error state for the whole panel.
			});
		return () => {
			cancelled = true;
		};
	}, [missions]);

	async function runAction(id: string, action: (id: string) => Promise<void>) {
		setBusyId(id);
		setError(null);
		try {
			await action(id);
			onRefresh();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyId(null);
			setConfirmDestroyId(null);
		}
	}

	return (
		<main>
			<div className="missions-toolbar">
				<h2 className="sec">Your missions</h2>
				{!creating && (
					<button
						type="button"
						className="btn-primary"
						onClick={() => setCreating(true)}
					>
						New mission
					</button>
				)}
			</div>
			{error && <p className="error-msg">{error}</p>}
			{creating && (
				<CreateMissionForm
					initialTemplateId={initialTemplateId}
					onClose={() => setCreating(false)}
					onCreated={(id) => {
						onRefresh();
						window.location.search = `?mission=${encodeURIComponent(id)}`;
					}}
				/>
			)}
			{missions.length === 0 && !creating && (
				<p className="mut">No missions yet — launch one from a template.</p>
			)}
			<ul className="missions">
				{missions.map((m) => {
					const s = stats[m.missionId];
					return (
						<li key={m.missionId} className="mission-row">
							<div className="mission-row-main">
								<a
									href={`?mission=${encodeURIComponent(m.missionId)}`}
									className="mission-name"
								>
									{m.name || m.missionId}
								</a>
								<StatusBadge status={m.status} />
								{!!s?.unread && (
									<span className="mission-unread-badge">
										{s.unread} unread
									</span>
								)}
								<span className="mut mission-date">
									{new Date(m.createdAt).toLocaleDateString()}
								</span>
								<div className="mission-actions">
									{confirmDestroyId === m.missionId ? (
										<>
											<span className="mut">Destroy permanently?</span>
											<button
												type="button"
												className="rail-btn mission-danger"
												disabled={busyId === m.missionId}
												onClick={() => runAction(m.missionId, deleteMission)}
											>
												Confirm
											</button>
											<button
												type="button"
												className="rail-btn"
												disabled={busyId === m.missionId}
												onClick={() => setConfirmDestroyId(null)}
											>
												Cancel
											</button>
										</>
									) : (
										<>
											{m.status === "running" && (
												<button
													type="button"
													className="rail-btn"
													disabled={busyId === m.missionId}
													onClick={() => runAction(m.missionId, suspendMission)}
												>
													Suspend
												</button>
											)}
											{m.status === "suspended" && (
												<button
													type="button"
													className="rail-btn"
													disabled={busyId === m.missionId}
													onClick={() => runAction(m.missionId, resumeMission)}
												>
													Resume
												</button>
											)}
											{m.status !== "destroyed" && (
												<button
													type="button"
													className="rail-btn"
													disabled={busyId === m.missionId}
													onClick={() => setConfirmDestroyId(m.missionId)}
												>
													Destroy
												</button>
											)}
										</>
									)}
								</div>
							</div>
							{s && (m.status === "running" || m.status === "suspended") && (
								<StatsLine s={s} maxCostUsd={m.mission?.maxCostUsd} />
							)}
						</li>
					);
				})}
			</ul>
		</main>
	);
}
