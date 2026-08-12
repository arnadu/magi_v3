import { html as htmlLang } from "@codemirror/lang-html";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useState } from "react";
import {
	fetchMissionConfig,
	fetchMissionStatus,
	type MissionConfigAgent,
	type MissionConfigData,
	type MissionStatusValue,
	saveMissionConfig,
} from "./data";

/**
 * Ported from index.html's renderConfigForm/renderAgentPane/saveConfig. Per
 * ADR-0022, only mission name/model/visionModel/timezone and per-agent
 * name/model/active/disabledSkills/disabledTools are editable, only while
 * the mission is suspended — everything else (id, supervisor, systemPrompt,
 * initialMentalMap, limits, linuxUser, teamFiles, missionCopilotLimits) must
 * round-trip unmodified, since the PUT is a full replace, not a patch.
 *
 * The live mental map is the one field ADR-0022 originally scoped out that
 * this panel now also edits directly (still suspended-only) — see the ADR's
 * "Post-ADR-0022 addendum" for why: the YAML-round-trip corruption risk that
 * motivated routing it through the mission copilot instead doesn't apply
 * here (this editor never touches YAML, for any field), and the remaining
 * risk — silently dropping a daemon-managed section — is now mechanically
 * checked server-side (managedRegionKeys) rather than only caught by an
 * LLM's judgment.
 */

/** Not a real roster entry — injected in-memory at daemon startup (ADR-0016), never in mission.agents. */
const MISSION_COPILOT_AGENT_ID = "mission-copilot";

const PLATFORM_SKILLS = [
	"git-provenance",
	"skill-creator",
	"postmessage-conventions",
	"run-background",
	"schedule-task",
	"objectives",
];

const TIER_A_TOOLS = [
	"Bash",
	"WriteFile",
	"EditFile",
	"PostMessage",
	"ListMessages",
	"ReadMessage",
	"ListTeam",
	"UpdateMentalMap",
	"FetchUrl",
	"InspectImage",
	"SearchWeb",
	"BrowseWeb",
	"Research",
	"AnalyzeMemories",
];

function availableSkills(teamFiles: Array<{ path: string }>): string[] {
	const team = teamFiles
		.map((f) => {
			const m = f.path.match(/^skills\/([^/]+)\/SKILL\.md$/);
			return m ? m[1] : null;
		})
		.filter((s): s is string => s !== null);
	return [...new Set([...PLATFORM_SKILLS, ...team])];
}

function orUndef(v: string): string | undefined {
	const s = v.trim();
	return s === "" ? undefined : s;
}

/**
 * Mental map viewer/editor — syntax-highlighted HTML source by default (never
 * executed, safe regardless of content), with an opt-in "Preview" toggle that
 * renders it in a sandboxed iframe. Same trust boundary FilesPanel's `.html`
 * viewer already uses for agent-authored (possibly web-influenced, TB-8)
 * HTML: no `allow-same-origin` on the sandbox, so even literal `<script>`
 * content can't read cookies or call the API with the operator's session.
 * `key={agentId}` at the call site remounts this fresh per agent, so the
 * view always resets to source when switching tabs.
 */
function MentalMapEditor({
	html,
	onChange,
	editable,
}: {
	html: string;
	onChange: (html: string) => void;
	editable: boolean;
}) {
	const [view, setView] = useState<"source" | "rendered">("source");
	return (
		<div className="config-mentalmap">
			<div className="config-mentalmap-toolbar">
				<button
					type="button"
					className="rail-btn"
					onClick={() =>
						setView((v) => (v === "rendered" ? "source" : "rendered"))
					}
				>
					{view === "rendered" ? "</> Source" : "👁 Preview"}
				</button>
			</div>
			{view === "rendered" ? (
				<iframe
					className="config-mentalmap-frame"
					title="Mental map preview"
					srcDoc={html}
					sandbox="allow-scripts"
				/>
			) : (
				<CodeMirror
					value={html}
					extensions={[htmlLang()]}
					readOnly={!editable}
					onChange={onChange}
					height="220px"
				/>
			)}
		</div>
	);
}

export function ConfigPanel({ missionId }: { missionId: string | null }) {
	const [config, setConfig] = useState<MissionConfigData | "error" | null>(
		null,
	);
	const [status, setStatus] = useState<MissionStatusValue | null>(null);
	const [missionDraft, setMissionDraft] = useState({
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

	useEffect(() => {
		if (!missionId) return;
		let cancelled = false;
		setConfig(null);
		Promise.all([fetchMissionConfig(missionId), fetchMissionStatus(missionId)])
			.then(([c, s]) => {
				if (cancelled) return;
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

	if (!missionId) {
		return <p className="mut">Select a live mission to see its config.</p>;
	}
	if (config === null) return <p className="mut">Loading…</p>;
	if (config === "error")
		return <p className="error-msg">Could not load this mission's config.</p>;

	const canEdit = status === "suspended";
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

	function updateMentalMap(agentId: string, html: string) {
		setMentalMapDrafts((prev) => ({ ...prev, [agentId]: html }));
	}

	async function handleSave() {
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

	return (
		<div className="config-panel">
			{!canEdit && (
				<p className="config-hint mut">
					Mission must be suspended to edit config — currently{" "}
					{status ?? "unknown"}.
				</p>
			)}
			<div className="config-mission-fields">
				<div className="create-mission-row">
					<label htmlFor="cfg-mission-name">Mission name</label>
					<input
						id="cfg-mission-name"
						value={missionDraft.name}
						disabled={!canEdit}
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, name: e.target.value }))
						}
					/>
				</div>
				<div className="create-mission-row">
					<label htmlFor="cfg-mission-model">Model</label>
					<input
						id="cfg-mission-model"
						value={missionDraft.model}
						disabled={!canEdit}
						placeholder="(deployment default)"
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, model: e.target.value }))
						}
					/>
				</div>
				<div className="create-mission-row">
					<label htmlFor="cfg-mission-vmodel">Vision model</label>
					<input
						id="cfg-mission-vmodel"
						value={missionDraft.visionModel}
						disabled={!canEdit}
						placeholder="(deployment default)"
						onChange={(e) =>
							setMissionDraft((d) => ({ ...d, visionModel: e.target.value }))
						}
					/>
				</div>
				<div className="create-mission-row">
					<label htmlFor="cfg-mission-tz">Timezone</label>
					<input
						id="cfg-mission-tz"
						value={missionDraft.timezone}
						disabled={!canEdit}
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
				<button
					type="button"
					className={`home-tab${selectedAgentId === MISSION_COPILOT_AGENT_ID ? " home-tab-active" : ""}`}
					onClick={() => setSelectedAgentId(MISSION_COPILOT_AGENT_ID)}
				>
					🤖 Mission Copilot
				</button>
			</nav>

			{selectedAgent && (
				<div className="config-agent-form">
					<div className="agent-id-badge mut">id: {selectedAgent.id}</div>
					<label className="config-active-row">
						<input
							type="checkbox"
							checked={selectedAgent.active !== false}
							disabled={!canEdit}
							onChange={(e) =>
								updateAgent(selectedAgent.id, { active: e.target.checked })
							}
						/>
						Active — agent participates in dispatch
					</label>
					<div className="create-mission-row">
						<label htmlFor="cfg-agent-name">Name</label>
						<input
							id="cfg-agent-name"
							value={selectedAgent.name ?? ""}
							disabled={!canEdit}
							onChange={(e) =>
								updateAgent(selectedAgent.id, { name: e.target.value })
							}
						/>
					</div>
					<div className="create-mission-row">
						<label htmlFor="cfg-agent-model">Model</label>
						<input
							id="cfg-agent-model"
							value={selectedAgent.model ?? ""}
							disabled={!canEdit}
							placeholder="(inherits mission model)"
							onChange={(e) =>
								updateAgent(selectedAgent.id, { model: e.target.value })
							}
						/>
					</div>

					<div className="config-section-label mut">Supervisor</div>
					<p className="mut config-readonly-note">
						Read-only — edit via the mission copilot (structural team change)
					</p>
					<input value={selectedAgent.supervisor} disabled />

					<div className="config-section-label mut">System prompt</div>
					<p className="mut config-readonly-note">
						Read-only — edit via the mission copilot (SaveMissionConfig)
					</p>
					<textarea
						className="config-readonly-textarea"
						value={selectedAgent.systemPrompt}
						disabled
						rows={6}
					/>

					{selectedAgent.id in mentalMapDrafts ? (
						<>
							<div className="config-section-label mut">Mental map</div>
							<p className="mut config-readonly-note">
								{canEdit
									? "Editable while suspended — dropping a daemon-managed section (e.g. objectives sync, supervisor note) is blocked on save."
									: "Read-only while running — suspend the mission to edit, or use the mission copilot (EditAgentMentalMap)."}
							</p>
							<MentalMapEditor
								key={selectedAgent.id}
								html={mentalMapDrafts[selectedAgent.id]}
								editable={canEdit}
								onChange={(next) => updateMentalMap(selectedAgent.id, next)}
							/>
						</>
					) : (
						<>
							<div className="config-section-label mut">Mental map</div>
							<p className="mut config-readonly-note">
								No live mental map yet — this agent hasn't run this mission.
							</p>
						</>
					)}

					<div className="config-section-label mut">Skills</div>
					<div className="config-toggle-grid">
						{skills.map((s) => (
							<label key={s} className="skill-toggle-row">
								<input
									type="checkbox"
									checked={!(selectedAgent.disabledSkills ?? []).includes(s)}
									disabled={!canEdit}
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
									disabled={!canEdit}
									onChange={() => toggleTool(selectedAgent, t)}
								/>
								{t}
							</label>
						))}
					</div>
				</div>
			)}

			{selectedAgentId === MISSION_COPILOT_AGENT_ID && (
				<div className="config-agent-form">
					<div className="agent-id-badge mut">
						id: {MISSION_COPILOT_AGENT_ID}
					</div>
					<p className="mut config-readonly-note">
						Injected automatically at daemon startup (ADR-0016) — not part of
						the authored roster, so name/model/active/skills/tools don't apply
						here.
					</p>

					<div className="config-section-label mut">Supervisor</div>
					<input value="user" disabled />

					<div className="config-section-label mut">System prompt</div>
					<p className="mut config-readonly-note">
						Read-only — generated fresh each session from a fixed platform
						template plus this mission's name and roster, not a stored field.
					</p>
					<textarea
						className="config-readonly-textarea"
						value={config.missionCopilot.systemPrompt}
						disabled
						rows={6}
					/>

					{MISSION_COPILOT_AGENT_ID in mentalMapDrafts ? (
						<>
							<div className="config-section-label mut">Mental map</div>
							<p className="mut config-readonly-note">
								{canEdit
									? "Editable while suspended — dropping a daemon-managed section is blocked on save."
									: "Read-only while running — suspend the mission to edit."}
							</p>
							<MentalMapEditor
								key={MISSION_COPILOT_AGENT_ID}
								html={mentalMapDrafts[MISSION_COPILOT_AGENT_ID]}
								editable={canEdit}
								onChange={(next) =>
									updateMentalMap(MISSION_COPILOT_AGENT_ID, next)
								}
							/>
						</>
					) : (
						<>
							<div className="config-section-label mut">Mental map</div>
							<p className="mut config-readonly-note">
								No live mental map yet — the copilot hasn't run this mission.
							</p>
						</>
					)}
				</div>
			)}

			<div className="config-save-bar">
				<button
					type="button"
					className="btn-primary"
					disabled={!canEdit || saving}
					onClick={handleSave}
				>
					{saving ? "Saving…" : "Save"}
				</button>
				{saved && <span className="config-save-ok">Saved</span>}
				{saveError && <span className="error-msg">{saveError}</span>}
			</div>
		</div>
	);
}
