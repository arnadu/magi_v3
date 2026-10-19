import { AgentToggles } from "./AgentToggles";
import type { MissionConfigAgent } from "./data";
import { MentalMapSection } from "./MentalMapSection";

type ToggleProps = Parameters<typeof AgentToggles>[0];

/** One authored agent of a running mission: editable while suspended. */
export function ConfigAgentForm({
	agent,
	canEdit,
	skills,
	tools,
	mentalMaps,
	onUpdate,
	onMentalMapChange,
}: {
	agent: MissionConfigAgent;
	canEdit: boolean;
	skills: ToggleProps["skills"];
	tools: ToggleProps["tools"];
	mentalMaps: Record<string, string>;
	onUpdate: (patch: Partial<MissionConfigAgent>) => void;
	onMentalMapChange: (agentId: string, html: string) => void;
}) {
	return (
		<div className="config-agent-form">
			<div className="agent-id-badge mut">id: {agent.id}</div>
			<label className="config-active-row">
				<input
					type="checkbox"
					checked={agent.active !== false}
					disabled={!canEdit}
					onChange={(e) => onUpdate({ active: e.target.checked })}
				/>
				Active — agent participates in dispatch
			</label>
			<div className="create-mission-row">
				<label htmlFor="cfg-agent-name">Name</label>
				<input
					id="cfg-agent-name"
					value={agent.name ?? ""}
					disabled={!canEdit}
					onChange={(e) => onUpdate({ name: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="cfg-agent-model">Model</label>
				<input
					id="cfg-agent-model"
					value={agent.model ?? ""}
					disabled={!canEdit}
					placeholder="(inherits mission model)"
					onChange={(e) => onUpdate({ model: e.target.value })}
				/>
			</div>

			<div className="config-section-label mut">Supervisor</div>
			<p className="mut config-readonly-note">
				Agent id this one reports to — "user" for a top-level agent.
				{!canEdit &&
					" Suspend the mission to edit yourself, or ask the mission copilot for a suggested change."}
			</p>
			<input
				value={agent.supervisor}
				disabled={!canEdit}
				onChange={(e) => onUpdate({ supervisor: e.target.value })}
			/>

			<div className="config-section-label mut">System prompt</div>
			<p className="mut config-readonly-note">
				{canEdit
					? "Editable while suspended."
					: "Read-only while running — suspend the mission to edit yourself, or ask the mission copilot for a suggested change."}
			</p>
			<textarea
				className="config-readonly-textarea"
				value={agent.systemPrompt}
				disabled={!canEdit}
				onChange={(e) => onUpdate({ systemPrompt: e.target.value })}
				rows={6}
			/>

			<MentalMapSection
				agentId={agent.id}
				drafts={mentalMaps}
				canEdit={canEdit}
				editableNote="Editable while suspended — dropping a daemon-managed section (e.g. objectives sync) is blocked on save."
				readOnlyNote="Read-only while running — suspend the mission to edit yourself, or ask the mission copilot for a suggested correction."
				notRunNote="No live mental map yet — this agent hasn't run this mission."
				onChange={onMentalMapChange}
			/>

			<AgentToggles
				agent={agent}
				skills={skills}
				tools={tools}
				disabled={!canEdit}
				onChange={(patch) => onUpdate(patch)}
			/>
		</div>
	);
}
