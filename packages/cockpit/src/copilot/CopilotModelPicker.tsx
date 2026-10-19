import { useState } from "react";
import {
	type CopilotSettings,
	fetchCopilotSettings,
	saveCopilotSettings,
} from "../data";

/** The copilot header's model button and its picker. */
export function CopilotModelPicker({
	settings,
	onSaved,
}: {
	settings: CopilotSettings | null;
	onSaved: (s: CopilotSettings) => void;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);
	const [modelInput, setModelInput] = useState("");
	const [modelError, setModelError] = useState<string | null>(null);

	async function handleSaveModel() {
		setModelError(null);
		try {
			await saveCopilotSettings(modelInput.trim() || null);
			onSaved(await fetchCopilotSettings());
			setPickerOpen(false);
		} catch (e) {
			setModelError((e as Error).message);
		}
	}

	return (
		<>
			<button
				type="button"
				className="rail-btn copilot-model-btn"
				title="Change the copilot's model"
				onClick={() => {
					setModelInput(settings && !settings.isDefault ? settings.model : "");
					setPickerOpen((v) => !v);
				}}
			>
				{settings
					? settings.isDefault
						? `model: ${settings.model} (default)`
						: `model: ${settings.model}`
					: "model"}
			</button>
			{pickerOpen && (
				<div className="copilot-model-picker">
					<label htmlFor="copilot-model-input">
						Copilot model — leave blank for the deployment default
					</label>
					<input
						id="copilot-model-input"
						value={modelInput}
						onChange={(e) => setModelInput(e.target.value)}
						placeholder="e.g. claude-opus-4-8"
					/>
					<button
						type="button"
						className="btn-primary"
						onClick={handleSaveModel}
					>
						Save
					</button>
					<button
						type="button"
						className="rail-btn"
						onClick={() => setPickerOpen(false)}
					>
						Cancel
					</button>
					{modelError && (
						<p className="error-msg copilot-model-error">{modelError}</p>
					)}
				</div>
			)}
		</>
	);
}
