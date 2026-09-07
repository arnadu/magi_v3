import { useEffect, useState } from "react";
import { availableSkills, MentalMapEditor, TIER_A_TOOLS } from "./ConfigPanel";
import {
	fetchMissionConfig,
	launchDraft,
	type MissionConfigAgent,
	type MissionConfigData,
	saveDraftConfig,
} from "./data";

/**
 * Pre-launch config editor for a "draft" mission — visually modeled on
 * ConfigPanel.tsx (same field layout, same `.config-*`/skill-toggle styling),
 * but for a document that has never run: every field is always editable (no
 * suspended-only gate, since there's no live agent to collide with), and it
 * adds the one piece of editing that has never existed anywhere else in this
 * codebase — a true agent-roster editor (add/remove agents, freely rename
 * ids). systemPrompt/initialMentalMap/supervisor are real inputs here instead
 * of ConfigPanel's hardcoded read-only ("edit via the mission copilot") —
 * that restriction is a live-mission safety rule (ADR-0022) that doesn't
 * apply before a mission has ever been provisioned.
 *
 * Saves are permissive (PUT /:id/draft skips parseTeamConfig — a draft is
 * allowed to be incomplete while it's being built). Full validation happens
 * only on Launch (POST /:id/launch), surfaced here as a plain error banner
 * naming the exact missing field.
 */
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

export function DraftEditor({
	missionId,
	onLaunched,
	onBack,
}: {
	missionId: string;
	/** Navigates to the live mission dashboard once Launch succeeds. */
	onLaunched: (missionId: string) => void;
	onBack: () => void;
}) {
	const [config, setConfig] = useState<MissionConfigData | "error" | null>(
		null,
	);
	const [missionDraft, setMissionDraft] = useState({
		name: "",
		model: "",
		visionModel: "",
		timezone: "",
	});
	const [agentsDraft, setAgentsDraft] = useState<MissionConfigAgent[]>([]);
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const [nextAgentSeq, setNextAgentSeq] = useState(1);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [launching, setLaunching] = useState(false);
	const [launchError, setLaunchError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setConfig(null);
		fetchMissionConfig(missionId)
			.then((c) => {
				if (cancelled) return;
				setConfig(c);
				setMissionDraft({
					name: c.mission.name ?? "",
					model: c.mission.model ?? "",
					visionModel: c.mission.visionModel ?? "",
					timezone: c.mission.timezone ?? "",
				});
				setAgentsDraft(c.agents);
				setSelectedAgentId(c.agents[0]?.id ?? null);
			})
			.catch(() => {
				if (!cancelled) setConfig("error");
			});
		return () => {
			cancelled = true;
		};
	}, [missionId]);

	if (config === null) return <p className="mut">Loading…</p>;
	if (config === "error")
		return <p className="error-msg">Could not load this draft's config.</p>;

	const skills = availableSkills(config.teamFiles);
	const selectedAgent = agentsDraft.find((a) => a.id === selectedAgentId);

	function updateAgent(id: string, patch: Partial<MissionConfigAgent>) {
		setAgentsDraft((prev) =>
			prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
		);
	}

	function toggleSkill(agent: MissionConfigAgent, skill: string) {
		const disabled = new Set(agent.disabledSkills ?? []);
		if (disabled.has(skill)) disabled.delete(skill);
		else disabled.add(skill);
		updateAgent(agent.id, { disabledSkills: [...disabled] });
	}

	function toggleTool(agent: MissionConfigAgent, tool: string) {
		const disabled = new Set(agent.disabledTools ?? []);
		if (disabled.has(tool)) disabled.delete(tool);
		else disabled.add(tool);
		updateAgent(agent.id, { disabledTools: [...disabled] });
	}

	function handleAddAgent() {
		const id = `new-agent-${nextAgentSeq}`;
		setNextAgentSeq((n) => n + 1);
		setAgentsDraft((prev) => [...prev, blankAgent(id)]);
		setSelectedAgentId(id);
	}

	function handleRemoveAgent(id: string) {
		setAgentsDraft((prev) => {
			const next = prev.filter((a) => a.id !== id);
			if (selectedAgentId === id) {
				setSelectedAgentId(next[0]?.id ?? null);
			}
			return next;
		});
	}

	async function handleSave() {
		if (config === null || config === "error") return;
		setSaving(true);
		setSaveError(null);
		setSaved(false);
		const nextMission = {
			...config.mission,
			name: missionDraft.name.trim() ? missionDraft.name : config.mission.name,
			model: missionDraft.model.trim() || undefined,
			visionModel: missionDraft.visionModel.trim() || undefined,
			timezone: missionDraft.timezone.trim() || undefined,
		};
		try {
			await saveDraftConfig(missionId, {
				mission: nextMission,
				agents: agentsDraft,
				missionCopilotLimits: config.missionCopilotLimits,
				teamFiles: config.teamFiles,
			});
			setConfig({ ...config, mission: nextMission, agents: agentsDraft });
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
		} catch (e) {
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	async function handleLaunch() {
		setLaunching(true);
		setLaunchError(null);
		try {
			await handleSave();
			await launchDraft(missionId);
			onLaunched(missionId);
		} catch (e) {
			setLaunchError((e as Error).message);
		} finally {
			setLaunching(false);
		}
	}

	return (
		<div className="config-panel">
			<div className="missions-toolbar">
				<button type="button" className="header-back-btn" onClick={onBack}>
					← Missions
				</button>
				<h2 className="sec">Draft: {config.mission.name || missionId}</h2>
			</div>
			<p className="config-hint mut">
				Nothing is running yet — edit freely, save as often as you like, and
				click Launch when the roster is ready.
			</p>

			<div className="config-mission-fields">
				<div className="create-mission-row">
					<label htmlFor="draft-mission-name">Mission name</label>
					<input
						id="draft-mission-name"
						value={missionDraft.name}
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, name: e.target.value }))
						}
					/>
				</div>
				<div className="create-mission-row">
					<label htmlFor="draft-mission-model">Model</label>
					<input
						id="draft-mission-model"
						value={missionDraft.model}
						placeholder="(deployment default)"
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, model: e.target.value }))
						}
					/>
				</div>
				<div className="create-mission-row">
					<label htmlFor="draft-mission-vmodel">Vision model</label>
					<input
						id="draft-mission-vmodel"
						value={missionDraft.visionModel}
						placeholder="(deployment default)"
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, visionModel: e.target.value }))
						}
					/>
				</div>
				<div className="create-mission-row">
					<label htmlFor="draft-mission-tz">Timezone</label>
					<input
						id="draft-mission-tz"
						value={missionDraft.timezone}
						placeholder="e.g. America/New_York"
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, timezone: e.target.value }))
						}
					/>
				</div>
			</div>

			<nav className="config-agent-tabs">
				{agentsDraft.map((a) => (
					<button
						key={a.id}
						type="button"
						className={`home-tab${a.id === selectedAgentId ? " home-tab-active" : ""}`}
						onClick={() => setSelectedAgentId(a.id)}
					>
						{a.name || a.id}
					</button>
				))}
				<button type="button" className="rail-btn" onClick={handleAddAgent}>
					+ Add agent
				</button>
			</nav>

			{selectedAgent && (
				<div className="config-agent-form">
					<div className="create-mission-row">
						<label htmlFor="draft-agent-id">Agent ID</label>
						<input
							id="draft-agent-id"
							value={selectedAgent.id}
							onChange={(e) => {
								const nextId = e.target.value;
								const prevId = selectedAgent.id;
								setAgentsDraft((prev) =>
									prev.map((a) => (a.id === prevId ? { ...a, id: nextId } : a)),
								);
								setSelectedAgentId(nextId);
							}}
						/>
					</div>
					<label className="config-active-row">
						<input
							type="checkbox"
							checked={selectedAgent.active !== false}
							onChange={(e) =>
								updateAgent(selectedAgent.id, { active: e.target.checked })
							}
						/>
						Active — agent participates in dispatch
					</label>
					<div className="create-mission-row">
						<label htmlFor="draft-agent-name">Name</label>
						<input
							id="draft-agent-name"
							value={selectedAgent.name ?? ""}
							onChange={(e) =>
								updateAgent(selectedAgent.id, { name: e.target.value })
							}
						/>
					</div>
					<div className="create-mission-row">
						<label htmlFor="draft-agent-model">Model</label>
						<input
							id="draft-agent-model"
							value={selectedAgent.model ?? ""}
							placeholder="(inherits mission model)"
							onChange={(e) =>
								updateAgent(selectedAgent.id, { model: e.target.value })
							}
						/>
					</div>

					<div className="config-section-label mut">Supervisor</div>
					<p className="mut config-readonly-note">
						Agent id this one reports to — "user" for a top-level agent.
					</p>
					<input
						value={selectedAgent.supervisor}
						onChange={(e) =>
							updateAgent(selectedAgent.id, { supervisor: e.target.value })
						}
					/>

					<div className="config-section-label mut">System prompt</div>
					<textarea
						className="config-readonly-textarea"
						value={selectedAgent.systemPrompt}
						onChange={(e) =>
							updateAgent(selectedAgent.id, { systemPrompt: e.target.value })
						}
						rows={6}
					/>

					<div className="config-section-label mut">Initial mental map</div>
					<MentalMapEditor
						key={selectedAgent.id}
						html={selectedAgent.initialMentalMap}
						editable
						onChange={(next) =>
							updateAgent(selectedAgent.id, { initialMentalMap: next })
						}
					/>

					<div className="config-section-label mut">Skills</div>
					<div className="config-toggle-grid">
						{skills.map((s) => (
							<label key={s} className="skill-toggle-row">
								<input
									type="checkbox"
									checked={!(selectedAgent.disabledSkills ?? []).includes(s)}
									onChange={() => toggleSkill(selectedAgent, s)}
								/>
								{s}
							</label>
						))}
					</div>

					<div className="config-section-label mut">Tools</div>
					<div className="config-toggle-grid">
						{TIER_A_TOOLS.map((t) => (
							<label key={t} className="skill-toggle-row">
								<input
									type="checkbox"
									checked={!(selectedAgent.disabledTools ?? []).includes(t)}
									onChange={() => toggleTool(selectedAgent, t)}
								/>
								{t}
							</label>
						))}
					</div>

					<button
						type="button"
						className="rail-btn mission-danger"
						onClick={() => handleRemoveAgent(selectedAgent.id)}
					>
						Remove agent
					</button>
				</div>
			)}

			{agentsDraft.length === 0 && (
				<p className="mut">No agents yet — click "+ Add agent" to start.</p>
			)}

			<div className="config-save-bar">
				<button
					type="button"
					className="btn-primary"
					disabled={saving || launching}
					onClick={handleSave}
				>
					{saving ? "Saving…" : "Save"}
				</button>
				<button
					type="button"
					className="btn-primary"
					disabled={saving || launching}
					onClick={handleLaunch}
				>
					{launching ? "Launching…" : "Launch"}
				</button>
				{saved && <span className="config-save-ok">Saved</span>}
				{saveError && <span className="error-msg">{saveError}</span>}
				{launchError && <span className="error-msg">{launchError}</span>}
			</div>
		</div>
	);
}
