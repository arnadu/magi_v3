import type { MissionConfigAgent } from "./data";

/**
 * The per-agent "Skills" and "Tools" checkbox grids shared by the config
 * editor and the draft editor. A checked box means enabled; unchecking adds
 * the name to the agent's disabledSkills / disabledTools.
 */
export function AgentToggles({
	agent,
	skills,
	tools,
	disabled = false,
	onChange,
}: {
	agent: MissionConfigAgent;
	skills: string[];
	tools: string[];
	disabled?: boolean;
	onChange: (patch: Partial<MissionConfigAgent>) => void;
}) {
	const toggle = (field: "disabledSkills" | "disabledTools", name: string) => {
		const set = new Set(agent[field] ?? []);
		if (set.has(name)) set.delete(name);
		else set.add(name);
		onChange({ [field]: [...set] });
	};
	const grid = (
		label: string,
		names: string[],
		field: "disabledSkills" | "disabledTools",
	) => (
		<>
			<div className="config-section-label mut">{label}</div>
			<div className="config-toggle-grid">
				{names.map((n) => (
					<label key={n} className="skill-toggle-row">
						<input
							type="checkbox"
							checked={!(agent[field] ?? []).includes(n)}
							disabled={disabled}
							onChange={() => toggle(field, n)}
						/>
						{n}
					</label>
				))}
			</div>
		</>
	);
	return (
		<>
			{grid("Skills", skills, "disabledSkills")}
			{grid("Tools", tools, "disabledTools")}
		</>
	);
}
