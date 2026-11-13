import { ImageSettingsFields } from "./ImageSettingsFields";
import type { ImageMenuItem, ImageSettingsDraft } from "./image-settings";

/** The mission-level fields of a running mission's config (editable only while suspended). */
export interface ConfigMissionDraft {
	name: string;
	model: string;
	visionModel: string;
	timezone: string;
	image: ImageSettingsDraft;
}

export function ConfigMissionFields({
	value,
	canEdit,
	imageMenu,
	defaultImageModel,
	onChange,
}: {
	value: ConfigMissionDraft;
	canEdit: boolean;
	imageMenu: readonly ImageMenuItem[];
	defaultImageModel: string;
	onChange: (patch: Partial<ConfigMissionDraft>) => void;
}) {
	return (
		<div className="config-mission-fields">
			<div className="create-mission-row">
				<label htmlFor="cfg-mission-name">Mission name</label>
				<input
					id="cfg-mission-name"
					value={value.name}
					disabled={!canEdit}
					onChange={(e) => onChange({ name: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="cfg-mission-model">Model</label>
				<input
					id="cfg-mission-model"
					value={value.model}
					disabled={!canEdit}
					placeholder="(deployment default)"
					onChange={(e) => onChange({ model: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="cfg-mission-vmodel">Vision model</label>
				<input
					id="cfg-mission-vmodel"
					value={value.visionModel}
					disabled={!canEdit}
					placeholder="(deployment default)"
					onChange={(e) => onChange({ visionModel: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="cfg-mission-tz">Timezone</label>
				<input
					id="cfg-mission-tz"
					value={value.timezone}
					disabled={!canEdit}
					placeholder="e.g. America/New_York"
					onChange={(e) => onChange({ timezone: e.target.value })}
				/>
			</div>
			<ImageSettingsFields
				idPrefix="cfg"
				value={value.image}
				menu={imageMenu}
				defaultModel={defaultImageModel}
				canEdit={canEdit}
				onChange={(patch) => onChange({ image: { ...value.image, ...patch } })}
			/>
		</div>
	);
}
