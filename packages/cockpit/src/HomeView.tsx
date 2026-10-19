import { useState } from "react";
import { CopilotFilesPanel } from "./CopilotFilesPanel";
import { CopilotLimitsPanel } from "./CopilotLimitsPanel";
import { CopilotPanel } from "./CopilotPanel";
import { CopilotTranscriptsPanel } from "./CopilotTranscriptsPanel";
import type { MissionSummary } from "./data";
import { Header } from "./Header";
import { MissionsPanel } from "./MissionsPanel";
import { TabBar } from "./TabBar";
import { TemplatesPanel } from "./TemplatesPanel";

type HomeTab = "missions" | "templates" | "copilot";
type CopilotTab = "transcripts" | "files" | "limits";

const HOME_TABS = [
	{ id: "missions", label: "Missions" },
	{ id: "templates", label: "Templates" },
	{ id: "copilot", label: "Copilot" },
] as const;

const COPILOT_TABS = [
	{ id: "transcripts", label: "Transcripts" },
	{ id: "files", label: "Files" },
	{ id: "limits", label: "Limits" },
] as const;

/** The start page: missions list, templates, and the control-plane copilot's own panels. */
export function HomeView({
	missions,
	onRefresh,
}: {
	missions: MissionSummary[];
	onRefresh: () => void;
}) {
	const [homeTab, setHomeTab] = useState<HomeTab>("missions");
	const [copilotTab, setCopilotTab] = useState<CopilotTab>("transcripts");
	return (
		<div className="app-shell">
			<div className="app">
				<Header subtitle="select a mission" />
				<TabBar
					tabs={HOME_TABS}
					value={homeTab}
					onChange={setHomeTab}
					variant="home"
				/>
				{homeTab === "missions" && (
					<MissionsPanel
						missions={missions}
						onRefresh={onRefresh}
						initialTemplateId={new URLSearchParams(window.location.search).get(
							"launch",
						)}
					/>
				)}
				{homeTab === "templates" && (
					<TemplatesPanel
						onLaunch={(templateId) => {
							window.location.search = `?launch=${encodeURIComponent(templateId)}`;
						}}
					/>
				)}
				{homeTab === "copilot" && (
					<div className="col-main">
						<TabBar
							tabs={COPILOT_TABS}
							value={copilotTab}
							onChange={setCopilotTab}
						/>
						<div className="tab-body">
							{copilotTab === "transcripts" && <CopilotTranscriptsPanel />}
							{copilotTab === "files" && <CopilotFilesPanel />}
							{copilotTab === "limits" && <CopilotLimitsPanel />}
						</div>
					</div>
				)}
			</div>
			<CopilotPanel />
		</div>
	);
}
