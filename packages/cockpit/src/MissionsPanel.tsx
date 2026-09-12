import { useEffect, useState } from "react";
import {
	createDraft,
	createMission,
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
	draft: "draft",
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

/**
 * Alternative to CreateMissionForm's instant-launch flow: clones a template
 * (or starts blank) into a `status: "draft"` doc with no machine and no
 * validation gate, then hands off to the Draft Editor instead of the live
 * dashboard. Today's "New mission" flow is untouched — this is a second,
 * slower-but-editable entry point next to it.
 */
function CreateDraftForm({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (missionId: string) => void;
}) {
	const [templates, setTemplates] = useState<
		TemplateSummary[] | "error" | null
	>(null);
	const [templateId, setTemplateId] = useState("");
	const [name, setName] = useState("");
	const [missionIdTouched, setMissionIdTouched] = useState(false);
	const [missionId, setMissionId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchTemplates()
			.then((t) => {
				if (!cancelled) setTemplates(t);
			})
			.catch(() => {
				if (!cancelled) setTemplates("error");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	async function handleCreate() {
		if (!name.trim()) {
			setError("Enter a mission name.");
			return;
		}
		const id = missionId.trim() || slugify(name);
		setBusy(true);
		setError(null);
		try {
			await createDraft(id, name.trim(), templateId || undefined);
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
				<label htmlFor="new-draft-template">Start from</label>
				{templates === null && <span className="mut">Loading templates…</span>}
				{templates === "error" && (
					<span className="error-msg">Could not load templates.</span>
				)}
				{Array.isArray(templates) && (
					<select
						id="new-draft-template"
						value={templateId}
						onChange={(e) => setTemplateId(e.target.value)}
					>
						<option value="">Start blank</option>
						{templates.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))}
					</select>
				)}
			</div>
			<div className="create-mission-row">
				<label htmlFor="new-draft-name">Name</label>
				<input
					id="new-draft-name"
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						if (!missionIdTouched) setMissionId(slugify(e.target.value));
					}}
					placeholder="e.g. Q3 Sector Report"
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="new-draft-id">Mission ID</label>
				<input
					id="new-draft-id"
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
					disabled={busy || templates === null}
					onClick={handleCreate}
				>
					{busy ? "Creating…" : "Create draft"}
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
	const [creatingDraft, setCreatingDraft] = useState(false);
	const [busyId, setBusyId] = useState<string | null>(null);
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
		}
	}

	return (
		<main>
			<div className="missions-toolbar">
				<h2 className="sec">Your missions</h2>
				{!creating && !creatingDraft && (
					<>
						<button
							type="button"
							className="btn-primary"
							onClick={() => setCreating(true)}
						>
							New mission
						</button>
						<button
							type="button"
							className="rail-btn"
							onClick={() => setCreatingDraft(true)}
						>
							Customize first
						</button>
					</>
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
			{creatingDraft && (
				<CreateDraftForm
					onClose={() => setCreatingDraft(false)}
					onCreated={(id) => {
						window.location.search = `?draft=${encodeURIComponent(id)}`;
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
									href={
										m.status === "draft"
											? `?draft=${encodeURIComponent(m.missionId)}`
											: `?mission=${encodeURIComponent(m.missionId)}`
									}
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
								{/* Destroy is intentionally removed for now — the confirmation
								flow (one inline "Confirm" click, generic wording, shown even
								for a running mission) was thin enough to cause a real
								accidental destroy (2026-09-11). Re-add only with a typed-
								confirmation step; the backend route is disabled too
								(missions.ts DELETE /:id). */}
								<div className="mission-actions">
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
