import {
	type ImageMenuItem,
	type ImageSettingsDraft,
	isKindEnabled,
	kindLabel,
	kindsNote,
	menuKinds,
	menuLine,
	toggleKind,
} from "./image-settings";

/** Image generation settings: the image agent's model and the allowed kinds, with each kind's models and prices. */
export function ImageSettingsFields({
	idPrefix,
	value,
	menu,
	defaultModel,
	canEdit = true,
	onChange,
}: {
	idPrefix: string;
	value: ImageSettingsDraft;
	menu: readonly ImageMenuItem[];
	defaultModel: string;
	canEdit?: boolean;
	onChange: (patch: Partial<ImageSettingsDraft>) => void;
}) {
	const kinds = menuKinds(menu);
	const note = kindsNote(value.imageKinds, kinds);
	return (
		<fieldset className="image-settings">
			<legend>Image generation (CreateImage)</legend>
			<div className="create-mission-row">
				<label htmlFor={`${idPrefix}-image-model`}>Image agent model</label>
				<input
					id={`${idPrefix}-image-model`}
					value={value.imageAgentModel}
					disabled={!canEdit}
					placeholder={
						defaultModel ? `(default: ${defaultModel})` : "(default)"
					}
					onChange={(e) => onChange({ imageAgentModel: e.target.value })}
				/>
			</div>
			{kinds.length === 0 ? (
				<p className="mut">The image model menu could not be loaded.</p>
			) : (
				kinds.map((kind) => (
					<div key={kind} className="image-kind">
						<label>
							<input
								type="checkbox"
								checked={isKindEnabled(value.imageKinds, kind)}
								disabled={!canEdit}
								onChange={() =>
									onChange({
										imageKinds: toggleKind(value.imageKinds, kind, kinds),
									})
								}
							/>{" "}
							{kindLabel(kind)}
						</label>
						<ul className="mut">
							{menu
								.filter((m) => m.kind === kind)
								.map((m) => (
									<li key={m.id} title={m.strengths}>
										{menuLine(m)}
									</li>
								))}
						</ul>
					</div>
				))
			)}
			{note && <p className="config-hint mut">{note}</p>}
		</fieldset>
	);
}
