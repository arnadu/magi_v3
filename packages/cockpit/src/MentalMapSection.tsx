import { MentalMapEditor } from "./MentalMapEditor";

/** The live mental map of one agent: editable while suspended, read-only otherwise, or a note that it has not run yet. */
export function MentalMapSection({
	agentId,
	drafts,
	canEdit,
	editableNote,
	readOnlyNote,
	notRunNote,
	onChange,
}: {
	agentId: string;
	drafts: Record<string, string>;
	canEdit: boolean;
	editableNote: string;
	readOnlyNote: string;
	notRunNote: string;
	onChange: (agentId: string, html: string) => void;
}) {
	return (
		<>
			<div className="config-section-label mut">Mental map</div>
			{agentId in drafts ? (
				<>
					<p className="mut config-readonly-note">
						{canEdit ? editableNote : readOnlyNote}
					</p>
					<MentalMapEditor
						key={agentId}
						html={drafts[agentId]}
						editable={canEdit}
						onChange={(next) => onChange(agentId, next)}
					/>
				</>
			) : (
				<p className="mut config-readonly-note">{notRunNote}</p>
			)}
		</>
	);
}
