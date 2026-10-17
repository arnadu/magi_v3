/** The mission-level fields of the draft editor (name, models, timezone, spend cap). */

export interface MissionDraftFields {
	name: string;
	model: string;
	visionModel: string;
	timezone: string;
	/** Dollars as typed; blank means the platform default applies at launch. */
	maxCostUsd: string;
}

/**
 * What a save must satisfy before it leaves the browser: unique agent ids
 * (the server rejects duplicates at launch, after the operator has moved on)
 * and a spend cap that is blank or a positive dollar amount.
 */
export function validateDraft(
	agents: ReadonlyArray<{ id: string }>,
	fields: Pick<MissionDraftFields, "maxCostUsd">,
): { error: string } | { maxCostUsd: number | undefined } {
	const dupes = [
		...new Set(
			agents.map((a) => a.id).filter((id, i, all) => all.indexOf(id) !== i),
		),
	];
	if (dupes.length > 0) {
		return { error: `Agent ids must be unique: ${dupes.join(", ")}` };
	}
	const raw = fields.maxCostUsd.trim();
	if (raw === "") return { maxCostUsd: undefined };
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		return {
			error:
				"Spend cap must be a positive number of dollars (or blank for the default).",
		};
	}
	return { maxCostUsd: n };
}

export function DraftMissionFields({
	value,
	onChange,
}: {
	value: MissionDraftFields;
	onChange: (patch: Partial<MissionDraftFields>) => void;
}) {
	return (
		<div className="config-mission-fields">
			<div className="create-mission-row">
				<label htmlFor="draft-mission-name">Mission name</label>
				<input
					id="draft-mission-name"
					value={value.name}
					onChange={(e) => onChange({ name: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="draft-mission-model">Model</label>
				<input
					id="draft-mission-model"
					value={value.model}
					placeholder="(deployment default)"
					onChange={(e) => onChange({ model: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="draft-mission-vmodel">Vision model</label>
				<input
					id="draft-mission-vmodel"
					value={value.visionModel}
					placeholder="(deployment default)"
					onChange={(e) => onChange({ visionModel: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="draft-mission-tz">Timezone</label>
				<input
					id="draft-mission-tz"
					value={value.timezone}
					placeholder="e.g. America/New_York"
					onChange={(e) => onChange({ timezone: e.target.value })}
				/>
			</div>
			<div className="create-mission-row">
				<label htmlFor="draft-mission-cap">Spend cap (USD)</label>
				<input
					id="draft-mission-cap"
					type="number"
					min="1"
					step="1"
					value={value.maxCostUsd}
					placeholder="blank = platform default ($25)"
					onChange={(e) => onChange({ maxCostUsd: e.target.value })}
				/>
			</div>
		</div>
	);
}
