import { useEffect, useRef, useState } from "react";
import type { ConfigMissionDraft } from "./ConfigMissionFields";
import {
	fetchMissionConfig,
	fetchMissionStatus,
	fetchMissionUpdatedAt,
	type MissionConfigAgent,
	type MissionConfigData,
	type MissionStatusValue,
	saveMissionConfig,
} from "./data";

function orUndef(v: string): string | undefined {
	const s = v.trim();
	return s === "" ? undefined : s;
}

/**
 * A running mission's editable config: loaded with its status and the
 * updatedAt it was read at, which the save sends back so a stale tab cannot
 * overwrite a newer config. The PUT is a full replace, so every field this
 * editor does not touch round-trips unchanged.
 */
export function useMissionConfigEditor(missionId: string | null) {
	const [config, setConfig] = useState<MissionConfigData | "error" | null>(
		null,
	);
	const [status, setStatus] = useState<MissionStatusValue | null>(null);
	const [missionDraft, setMissionDraft] = useState<ConfigMissionDraft>({
		name: "",
		model: "",
		visionModel: "",
		timezone: "",
	});
	const [agentsDraft, setAgentsDraft] = useState<MissionConfigAgent[]>([]);
	const [mentalMapDrafts, setMentalMapDrafts] = useState<
		Record<string, string>
	>({});
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	/** updatedAt as loaded — sent with the save so a stale tab cannot overwrite a newer config. */
	const loadedUpdatedAtRef = useRef<string | null>(null);

	useEffect(() => {
		if (!missionId) return;
		let cancelled = false;
		setConfig(null);
		Promise.all([
			fetchMissionConfig(missionId),
			fetchMissionStatus(missionId),
			fetchMissionUpdatedAt(missionId),
		])
			.then(([c, s, updatedAt]) => {
				if (cancelled) return;
				loadedUpdatedAtRef.current = updatedAt;
				setConfig(c);
				setStatus(s);
				setMissionDraft({
					name: c.mission.name ?? "",
					model: c.mission.model ?? "",
					visionModel: c.mission.visionModel ?? "",
					timezone: c.mission.timezone ?? "",
				});
				setAgentsDraft(c.agents);
				setMentalMapDrafts({ ...c.mentalMaps });
				setSelectedAgentId(c.agents[0]?.id ?? null);
			})
			.catch(() => {
				if (!cancelled) setConfig("error");
			});
		return () => {
			cancelled = true;
		};
	}, [missionId]);

	function updateAgent(id: string, patch: Partial<MissionConfigAgent>) {
		setAgentsDraft((prev) =>
			prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
		);
	}

	function updateMentalMap(agentId: string, html: string) {
		setMentalMapDrafts((prev) => ({ ...prev, [agentId]: html }));
	}

	async function save() {
		if (config === null || config === "error" || !missionId) return;
		setSaving(true);
		setSaveError(null);
		setSaved(false);
		const nextMission = {
			...config.mission,
			name: missionDraft.name.trim() ? missionDraft.name : config.mission.name,
			model: orUndef(missionDraft.model),
			visionModel: orUndef(missionDraft.visionModel),
			timezone: orUndef(missionDraft.timezone),
		};
		try {
			await saveMissionConfig(missionId, {
				mission: nextMission,
				agents: agentsDraft,
				// Untouched by this editor (ADR-0022) — round-tripped so the save
				// can't silently clear either one; the API is a full replace.
				missionCopilotLimits: config.missionCopilotLimits,
				teamFiles: config.teamFiles,
				mentalMaps: mentalMapDrafts,
				expectedUpdatedAt: loadedUpdatedAtRef.current ?? undefined,
			});
			setConfig({ ...config, mission: nextMission, agents: agentsDraft });
			// Our own write moved updatedAt; re-read it so the next save is not refused.
			loadedUpdatedAtRef.current = await fetchMissionUpdatedAt(missionId);
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return {
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
		save,
	};
}
