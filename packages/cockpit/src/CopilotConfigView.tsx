import { MentalMapSection } from "./MentalMapSection";

/** Not a real roster entry — injected in-memory at daemon startup (ADR-0016), never in mission.agents. */
export const MISSION_COPILOT_AGENT_ID = "mission-copilot";

/** The mission copilot's tab: its generated prompt (read-only) and its live mental map. */
export function CopilotConfigView({
	systemPrompt,
	canEdit,
	mentalMaps,
	onMentalMapChange,
}: {
	systemPrompt: string;
	canEdit: boolean;
	mentalMaps: Record<string, string>;
	onMentalMapChange: (agentId: string, html: string) => void;
}) {
	return (
		<div className="config-agent-form">
			<div className="agent-id-badge mut">id: {MISSION_COPILOT_AGENT_ID}</div>
			<p className="mut config-readonly-note">
				Injected automatically at daemon startup (ADR-0016) — not part of the
				authored roster, so name/model/active/skills/tools don't apply here.
			</p>

			<div className="config-section-label mut">Supervisor</div>
			<input value="user" disabled />

			<div className="config-section-label mut">System prompt</div>
			<p className="mut config-readonly-note">
				Read-only — generated fresh each session from a fixed platform template
				plus this mission's name and roster, not a stored field.
			</p>
			<textarea
				className="config-readonly-textarea"
				value={systemPrompt}
				disabled
				rows={6}
			/>

			<MentalMapSection
				agentId={MISSION_COPILOT_AGENT_ID}
				drafts={mentalMaps}
				canEdit={canEdit}
				editableNote="Editable while suspended — dropping a daemon-managed section is blocked on save."
				readOnlyNote="Read-only while running — suspend the mission to edit."
				notRunNote="No live mental map yet — the copilot hasn't run this mission."
				onChange={onMentalMapChange}
			/>
		</div>
	);
}
