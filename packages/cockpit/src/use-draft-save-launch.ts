import { useState } from "react";
import { validateDraft } from "./DraftMissionFields";
import { launchDraft, saveDraftConfig } from "./data";
import type { useDraftState } from "./use-draft-state";

/**
 * Save and Launch for a draft. Launch saves first and stops if the save is
 * refused: a swallowed save error once started the paid mission from the
 * previous server config, dropping the edits on screen.
 */
export function useDraftSaveLaunch(
	missionId: string,
	draft: ReturnType<typeof useDraftState>,
	/** A counter, since a launch runs a save inside it: the poll stays paused until both end. */
	setBusy: (update: (n: number) => number) => void,
	onLaunched: (missionId: string) => void,
) {
	const [saving, setSaving] = useState(false);
	const [launching, setLaunching] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [launchError, setLaunchError] = useState<string | null>(null);

	/** Resolves true only when the server accepted the save — the launch depends on it. */
	async function save(): Promise<boolean> {
		const { config, missionDraft, agentsDraft } = draft;
		if (config === null || config === "error") return false;
		const checked = validateDraft(agentsDraft, missionDraft);
		if ("error" in checked) {
			setSaveError(checked.error);
			return false;
		}
		setSaving(true);
		setBusy((n) => n + 1);
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
			setBusy((n) => n - 1);
		}
	}

	async function launch(): Promise<void> {
		setLaunching(true);
		setBusy((n) => n + 1);
		setLaunchError(null);
		try {
			if (!(await save())) {
				setLaunchError("Not launched — fix the save error above first.");
				return;
			}
			await launchDraft(missionId);
			onLaunched(missionId);
		} catch (e) {
			setLaunchError((e as Error).message);
		} finally {
			setLaunching(false);
			setBusy((n) => n - 1);
		}
	}

	return {
		saving,
		launching,
		saveError,
		setSaveError,
		saved,
		launchError,
		save,
		launch,
	};
}
