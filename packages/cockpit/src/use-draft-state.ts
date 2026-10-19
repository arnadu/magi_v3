import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionDraftFields } from "./DraftMissionFields";
import {
	fetchMissionConfig,
	fetchMissionUpdatedAt,
	type MissionConfigAgent,
	type MissionConfigData,
} from "./data";

/** How often to check whether the copilot changed this draft while the operator has it open. */
const POLL_MS = 5000;

const EMPTY_FIELDS: MissionDraftFields = {
	name: "",
	model: "",
	visionModel: "",
	timezone: "",
	maxCostUsd: "",
};

function blankAgent(id: string): MissionConfigAgent {
	return {
		id,
		name: "",
		role: "",
		supervisor: "user",
		systemPrompt: "",
		initialMentalMap: "<h1>Role</h1>\n<p></p>\n",
		active: true,
	};
}

function fieldsOf(c: MissionConfigData): MissionDraftFields {
	return {
		name: c.mission.name ?? "",
		model: c.mission.model ?? "",
		visionModel: c.mission.visionModel ?? "",
		timezone: c.mission.timezone ?? "",
		maxCostUsd:
			typeof c.mission.maxCostUsd === "number"
				? String(c.mission.maxCostUsd)
				: "",
	};
}

/**
 * A draft's editable state, kept in step with the server. The copilot can
 * edit a draft directly (EditDraftConfig), so the server is polled; a remote
 * change is applied silently only while there are no local edits — with
 * unsaved edits open it is offered as a reload instead, because overwriting
 * the form would destroy work in progress. `busy` pauses the poll during a
 * save or launch.
 */
export function useDraftState(missionId: string, busy: boolean) {
	const [config, setConfig] = useState<MissionConfigData | "error" | null>(
		null,
	);
	const [missionDraft, setMissionDraft] =
		useState<MissionDraftFields>(EMPTY_FIELDS);
	const [agentsDraft, setAgentsDraft] = useState<MissionConfigAgent[]>([]);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [remoteUpdateAvailable, setRemoteUpdateAvailable] = useState(false);
	const lastLoadedUpdatedAtRef = useRef<string | null>(null);

	const applyConfig = useCallback((c: MissionConfigData) => {
		setConfig(c);
		setMissionDraft(fieldsOf(c));
		setAgentsDraft(c.agents);
		setSelectedAgentId((prev) =>
			prev && c.agents.some((a) => a.id === prev)
				? prev
				: (c.agents[0]?.id ?? null),
		);
		setDirty(false);
		setRemoteUpdateAvailable(false);
	}, []);

	const reload = useCallback(async () => {
		const [c, updatedAt] = await Promise.all([
			fetchMissionConfig(missionId),
			fetchMissionUpdatedAt(missionId),
		]);
		applyConfig(c);
		lastLoadedUpdatedAtRef.current = updatedAt;
	}, [missionId, applyConfig]);

	useEffect(() => {
		let cancelled = false;
		setConfig(null);
		Promise.all([
			fetchMissionConfig(missionId),
			fetchMissionUpdatedAt(missionId),
		])
			.then(([c, updatedAt]) => {
				if (cancelled) return;
				applyConfig(c);
				lastLoadedUpdatedAtRef.current = updatedAt;
			})
			.catch(() => {
				if (!cancelled) setConfig("error");
			});
		return () => {
			cancelled = true;
		};
	}, [missionId, applyConfig]);

	useEffect(() => {
		const timer = setInterval(async () => {
			if (busy) return;
			let updatedAt: string;
			try {
				updatedAt = await fetchMissionUpdatedAt(missionId);
			} catch {
				return; // Transient poll failure — try again next tick.
			}
			if (updatedAt === lastLoadedUpdatedAtRef.current) return;
			if (dirty) {
				setRemoteUpdateAvailable(true);
				return;
			}
			try {
				applyConfig(await fetchMissionConfig(missionId));
				lastLoadedUpdatedAtRef.current = updatedAt;
			} catch {
				// Transient — the next tick will retry.
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [missionId, dirty, busy, applyConfig]);

	/** After our own save: the new config is what's on screen, and the next poll must not mistake our write for a copilot change. */
	const markSaved = useCallback(
		(next: MissionConfigData) => {
			setConfig(next);
			setDirty(false);
			setRemoteUpdateAvailable(false);
			fetchMissionUpdatedAt(missionId)
				.then((updatedAt) => {
					lastLoadedUpdatedAtRef.current = updatedAt;
				})
				.catch(() => {
					// Non-fatal — worst case, the next poll re-reads a config that
					// already matches what's on screen and reloads it silently.
				});
		},
		[missionId],
	);

	const edit = draftEdits({
		agentsDraft,
		selectedAgentId,
		setDirty,
		setMissionDraft,
		setAgentsDraft,
		setSelectedAgentId,
	});

	return {
		config,
		missionDraft,
		agentsDraft,
		selectedAgentId,
		setSelectedAgentId,
		remoteUpdateAvailable,
		reload,
		markSaved,
		edit,
	};
}

type Setter<T> = (next: T | ((prev: T) => T)) => void;

/** The draft's edit operations; every one marks the draft dirty. */
function draftEdits(d: {
	agentsDraft: MissionConfigAgent[];
	selectedAgentId: string | null;
	setDirty: Setter<boolean>;
	setMissionDraft: Setter<MissionDraftFields>;
	setAgentsDraft: Setter<MissionConfigAgent[]>;
	setSelectedAgentId: Setter<string | null>;
}) {
	const {
		agentsDraft,
		selectedAgentId,
		setDirty,
		setMissionDraft,
		setAgentsDraft,
		setSelectedAgentId,
	} = d;
	return {
		missionField(patch: Partial<MissionDraftFields>) {
			setDirty(true);
			setMissionDraft((d) => ({ ...d, ...patch }));
		},
		agent(id: string, patch: Partial<MissionConfigAgent>) {
			setDirty(true);
			setAgentsDraft((prev) =>
				prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
			);
		},
		addAgent() {
			setDirty(true);
			// Derived from the ids that exist, not a counter: a counter restarted at
			// 1 on reload and produced a second "new-agent-1".
			const taken = new Set(agentsDraft.map((a) => a.id));
			let n = 1;
			while (taken.has(`new-agent-${n}`)) n++;
			const id = `new-agent-${n}`;
			setAgentsDraft((prev) => [...prev, blankAgent(id)]);
			setSelectedAgentId(id);
		},
		removeAgent(id: string) {
			setDirty(true);
			setAgentsDraft((prev) => {
				const next = prev.filter((a) => a.id !== id);
				if (selectedAgentId === id) setSelectedAgentId(next[0]?.id ?? null);
				return next;
			});
		},
		/** Renaming cascades to whoever reported to the old id — a stale `supervisor` is a config the server rejects at launch. */
		renameAgent(prevId: string, nextId: string) {
			setDirty(true);
			setAgentsDraft((prev) =>
				prev.map((a) => {
					if (a.id === prevId) return { ...a, id: nextId };
					return a.supervisor === prevId ? { ...a, supervisor: nextId } : a;
				}),
			);
			setSelectedAgentId(nextId);
		},
	};
}
