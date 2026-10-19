import { availableSkills } from "./available-skills";
import { ConfigAgentForm } from "./ConfigAgentForm";
import { ConfigMissionFields } from "./ConfigMissionFields";
import {
	CopilotConfigView,
	MISSION_COPILOT_AGENT_ID,
} from "./CopilotConfigView";
import { useCatalog } from "./use-catalog";
import { useMissionConfigEditor } from "./use-mission-config-editor";

/**
 * Ported from index.html's renderConfigForm/renderAgentPane/saveConfig.
 * Editable, only while the mission is suspended: mission
 * name/model/visionModel/timezone; per-agent name/model/active/
 * disabledSkills/disabledTools/supervisor/systemPrompt; the live mental map.
 * Everything else (id, initialMentalMap post-launch, limits, linuxUser,
 * teamFiles, missionCopilotLimits) must round-trip unmodified, since the PUT
 * is a full replace, not a patch.
 *
 * supervisor/systemPrompt were mission-copilot-only under ADR-0022's original
 * decision (an actor that reads current state before writing catches a
 * prompt regression or a supervisor cycle that a blind form save can't) —
 * the ADR now gives the operator direct control instead, by explicit product
 * decision rather than a new technical mitigation like the mental map below.
 * The safety net is the same one every other field in this panel already
 * relies on: server-side `parseTeamConfig` validation and the suspended-only
 * gate, not a copilot's judgment.
 *
 * The live mental map is the other field ADR-0022 originally scoped out that
 * this panel also edits directly (still suspended-only) — see the ADR's
 * "Post-ADR-0022 addendum" for why: the YAML-round-trip corruption risk that
 * motivated routing it through the mission copilot instead doesn't apply
 * here (this editor never touches YAML, for any field), and the remaining
 * risk — silently dropping a daemon-managed section — is now mechanically
 * checked server-side (managedRegionKeys) rather than only caught by an
 * LLM's judgment.
 */

export function ConfigPanel({ missionId }: { missionId: string | null }) {
	const { catalog } = useCatalog();
	const editor = useMissionConfigEditor(missionId);
	const {
		config,
		status,
		missionDraft,
		setMissionDraft,
		agentsDraft,
		mentalMapDrafts,
		selectedAgentId,
		setSelectedAgentId,
		saving,
		saveError,
		saved,
		updateAgent,
		updateMentalMap,
		save: handleSave,
	} = editor;

	if (!missionId) {
		return <p className="mut">Select a live mission to see its config.</p>;
	}
	if (config === null) return <p className="mut">Loading…</p>;
	if (config === "error")
		return <p className="error-msg">Could not load this mission's config.</p>;

	const canEdit = status === "suspended";
	const skills = availableSkills(catalog.platformSkills, config.teamFiles);
	const selectedAgent = agentsDraft.find((a) => a.id === selectedAgentId);

	return (
		<div className="config-panel">
			{!canEdit && (
				<p className="config-hint mut">
					Mission must be suspended to edit config — currently{" "}
					{status ?? "unknown"}.
				</p>
			)}
			<ConfigMissionFields
				value={missionDraft}
				canEdit={canEdit}
				onChange={(patch) => setMissionDraft((d) => ({ ...d, ...patch }))}
			/>

			<nav className="config-agent-tabs">
				{agentsDraft.map((a) => (
					<button
						key={a.id}
						type="button"
						className={`home-tab${a.id === selectedAgentId ? " home-tab-active" : ""}`}
						onClick={() => setSelectedAgentId(a.id)}
					>
						{a.name || a.id}
					</button>
				))}
				<button
					type="button"
					className={`home-tab${selectedAgentId === MISSION_COPILOT_AGENT_ID ? " home-tab-active" : ""}`}
					onClick={() => setSelectedAgentId(MISSION_COPILOT_AGENT_ID)}
				>
					🤖 Mission Copilot
				</button>
			</nav>

			{selectedAgent && (
				<ConfigAgentForm
					agent={selectedAgent}
					canEdit={canEdit}
					skills={skills}
					tools={catalog.tierATools}
					mentalMaps={mentalMapDrafts}
					onUpdate={(patch) => updateAgent(selectedAgent.id, patch)}
					onMentalMapChange={updateMentalMap}
				/>
			)}

			{selectedAgentId === MISSION_COPILOT_AGENT_ID && (
				<CopilotConfigView
					systemPrompt={config.missionCopilot.systemPrompt}
					canEdit={canEdit}
					mentalMaps={mentalMapDrafts}
					onMentalMapChange={updateMentalMap}
				/>
			)}

			<div className="config-save-bar">
				<button
					type="button"
					className="btn-primary"
					disabled={!canEdit || saving}
					onClick={handleSave}
				>
					{saving ? "Saving…" : "Save"}
				</button>
				{saved && <span className="config-save-ok">Saved</span>}
				{saveError && <span className="error-msg">{saveError}</span>}
			</div>
		</div>
	);
}
