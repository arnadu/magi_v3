import { AgentToggles } from "./AgentToggles";
import type { MissionConfigAgent } from "./data";
import { MentalMapEditor } from "./MentalMapEditor";

type ToggleProps = Parameters<typeof AgentToggles>[0];

/** One draft agent's fields: id (rename cascades), name, model, supervisor, prompt, mental map, skills and tools. */
export function DraftAgentForm({
	agent,
	skills,
	tools,
	onUpdate,
	onRename,
	onRemove,
}: {
	agent: MissionConfigAgent;
	skills: ToggleProps["skills"];
	tools: ToggleProps["tools"];
	onUpdate: (patch: Partial<MissionConfigAgent>) => void;
	onRename: (nextId: string) => void;
	onRemove: () => void;
}) {
	return (
		<div className="config-agent-form">
			<div className="create-mission-row">
				<label htmlFor="draft-agent-id">Agent ID</label>
				<input
					id="draft-agent-id"
					value={agent.id}
					onChange={(e) => onRename(e.target.value)}
				/>
			</div>
			<label className="config-active-row">
				<input
					type="checkbox"
					checked={agent.active !== false}
					onChange={(e) => onUpdate({ active: e.target.checked })}
				/>
				Active — agent participates in dispatch
			</label>
			<div className="create-mission-row">
				<label htmlFor="draft-agent-name">Name</label>
				<input
					id="draft-agent-name"
					value={agent.name ?? ""}
					onChange={(e) => onUpdate({ name: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="draft-agent-model">Model</label>
				<input
					id="draft-agent-model"
					value={agent.model ?? ""}
					placeholder="(inherits mission model)"
					onChange={(e) => onUpdate({ model: e.target.value })}
				/>
			</div>

			<div className="config-section-label mut">Supervisor</div>
			<p className="mut config-readonly-note">
				Agent id this one reports to — "user" for a top-level agent.
			</p>
			<input
				value={agent.supervisor ?? ""}
				onChange={(e) => onUpdate({ supervisor: e.target.value })}
			/>

			<div className="config-section-label mut">System prompt</div>
			<textarea
				className="config-readonly-textarea"
				value={agent.systemPrompt ?? ""}
				onChange={(e) => onUpdate({ systemPrompt: e.target.value })}
				rows={6}
			/>

			<div className="config-section-label mut">Initial mental map</div>
			<MentalMapEditor
				key={agent.id}
				html={agent.initialMentalMap ?? ""}
				editable
				onChange={(next) => onUpdate({ initialMentalMap: next })}
			/>

			<AgentToggles
				agent={agent}
				skills={skills}
				tools={tools}
				onChange={(patch) => onUpdate(patch)}
			/>

			<button
				type="button"
				className="rail-btn mission-danger"
				onClick={onRemove}
			>
				Remove agent
			</button>
		</div>
	);
}
