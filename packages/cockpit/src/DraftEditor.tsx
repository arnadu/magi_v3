import { useState } from "react";
import { availableSkills } from "./ConfigPanel";
import { DraftAgentForm } from "./DraftAgentForm";
import { DraftMissionFields, validateDraft } from "./DraftMissionFields";
import { launchDraft, saveDraftConfig } from "./data";
import { useCatalog } from "./use-catalog";
import { useDraftState } from "./use-draft-state";

/**
 * Pre-launch config editor for a "draft" mission — visually modeled on
 * ConfigPanel.tsx (same field layout, same `.config-*`/skill-toggle styling),
 * but for a document that has never run: every field is always editable (no
 * suspended-only gate, since there's no live agent to collide with), and it
 * adds the one piece of editing that has never existed anywhere else in this
 * codebase — a true agent-roster editor (add/remove agents, freely rename
 * ids). initialMentalMap is a real input here where ConfigPanel keeps it
 * read-only post-launch (there it's inert once an agent has run once — the
 * live mental map is what matters, ADR-0022); systemPrompt/supervisor are
 * editable in both, gated by suspended-only in ConfigPanel vs. always-on
 * here, since a draft has no live agent to collide with.
 *
 * Saves are permissive (PUT /:id/draft skips parseTeamConfig — a draft is
 * allowed to be incomplete while it's being built). Full validation happens
 * only on Launch (POST /:id/launch), surfaced here as a plain error banner
 * naming the exact missing field.
 */
export function DraftEditor({
	missionId,
	onLaunched,
	onBack,
}: {
	missionId: string;
	/** Navigates to the live mission dashboard once Launch succeeds. */
	onLaunched: (missionId: string) => void;
	onBack: () => void;
}) {
	const { catalog } = useCatalog();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [launching, setLaunching] = useState(false);
	const [launchError, setLaunchError] = useState<string | null>(null);
	const draft = useDraftState(missionId, saving || launching);
	const { config, missionDraft, agentsDraft, selectedAgentId, edit } = draft;

	if (config === null) return <p className="mut">Loading…</p>;
	if (config === "error")
		return <p className="error-msg">Could not load this draft's config.</p>;

	const skills = availableSkills(catalog.platformSkills, config.teamFiles);
	const selectedAgent = agentsDraft.find((a) => a.id === selectedAgentId);
	/** Ids used more than once — a save with one of these is refused, the server would reject it anyway. */
	const duplicateIds = agentsDraft
		.map((a) => a.id)
		.filter((id, i, all) => all.indexOf(id) !== i);

	/** Resolves true only when the server accepted the save — the launch depends on it. */
	async function handleSave(): Promise<boolean> {
		if (config === null || config === "error") return false;
		const checked = validateDraft(agentsDraft, missionDraft);
		if ("error" in checked) {
			setSaveError(checked.error);
			return false;
		}
		setSaving(true);
		setSaveError(null);
		setSaved(false);
		const nextMission = {
			...config.mission,
			name: missionDraft.name.trim() ? missionDraft.name : config.mission.name,
			model: missionDraft.model.trim() || undefined,
			visionModel: missionDraft.visionModel.trim() || undefined,
			timezone: missionDraft.timezone.trim() || undefined,
			maxCostUsd: checked.maxCostUsd,
		};
		try {
			await saveDraftConfig(missionId, {
				mission: nextMission,
				agents: agentsDraft,
				missionCopilotLimits: config.missionCopilotLimits,
				teamFiles: config.teamFiles,
			});
			draft.markSaved({ ...config, mission: nextMission, agents: agentsDraft });
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
			return true;
		} catch (e) {
			setSaveError((e as Error).message);
			return false;
		} finally {
			setSaving(false);
		}
	}

	async function handleLaunch() {
		setLaunching(true);
		setLaunchError(null);
		try {
			// A failed save used to be swallowed here and the paid mission started
			// from the previous server config, dropping the edits on screen.
			if (!(await handleSave())) {
				setLaunchError("Not launched — fix the save error above first.");
				return;
			}
			await launchDraft(missionId);
			onLaunched(missionId);
		} catch (e) {
			setLaunchError((e as Error).message);
		} finally {
			setLaunching(false);
		}
	}

	return (
		<div className="config-panel">
			<div className="missions-toolbar">
				<button type="button" className="header-back-btn" onClick={onBack}>
					← Missions
				</button>
				<h2 className="sec">Draft: {config.mission.name || missionId}</h2>
			</div>
			<p className="config-hint mut">
				Nothing is running yet — edit freely, save as often as you like, and
				click Launch when the roster is ready.
			</p>
			{draft.remoteUpdateAvailable && (
				<p className="config-hint">
					The copilot updated this draft while you were editing it.{" "}
					<button
						type="button"
						className="rail-btn"
						onClick={() =>
							draft.reload().catch((e) => setSaveError((e as Error).message))
						}
					>
						Reload
					</button>{" "}
					— this replaces your unsaved changes with the copilot's version.
				</p>
			)}
			<DraftMissionFields value={missionDraft} onChange={edit.missionField} />
			{duplicateIds.length > 0 && (
				<p className="error-msg">
					Duplicate agent id: {[...new Set(duplicateIds)].join(", ")} — ids must
					be unique.
				</p>
			)}
			<nav className="config-agent-tabs">
				{agentsDraft.map((a) => (
					<button
						key={a.id}
						type="button"
						className={`home-tab${a.id === selectedAgentId ? " home-tab-active" : ""}`}
						onClick={() => draft.setSelectedAgentId(a.id)}
					>
						{a.name || a.id}
					</button>
				))}
				<button type="button" className="rail-btn" onClick={edit.addAgent}>
					+ Add agent
				</button>
			</nav>
			{selectedAgent && (
				<DraftAgentForm
					agent={selectedAgent}
					skills={skills}
					tools={catalog.tierATools}
					onUpdate={(patch) => edit.agent(selectedAgent.id, patch)}
					onRename={(nextId) => edit.renameAgent(selectedAgent.id, nextId)}
					onRemove={() => edit.removeAgent(selectedAgent.id)}
				/>
			)}
			{agentsDraft.length === 0 && (
				<p className="mut">No agents yet — click "+ Add agent" to start.</p>
			)}
			<div className="config-save-bar">
				<button
					type="button"
					className="btn-primary"
					disabled={saving || launching}
					onClick={handleSave}
				>
					{saving ? "Saving…" : "Save"}
				</button>
				<button
					type="button"
					className="btn-primary"
					disabled={saving || launching}
					onClick={handleLaunch}
				>
					{launching ? "Launching…" : "Launch"}
				</button>
				{saved && <span className="config-save-ok">Saved</span>}
				{saveError && <span className="error-msg">{saveError}</span>}
				{launchError && <span className="error-msg">{launchError}</span>}
			</div>
		</div>
	);
}
