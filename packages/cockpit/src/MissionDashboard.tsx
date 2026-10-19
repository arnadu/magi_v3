import { useState } from "react";
import { AgentErrorBanner } from "./AgentErrorBanner";
import { useMissionStatus, type View } from "./app-hooks";
import { ConfigPanel } from "./ConfigPanel";
import { ConversationsPanel } from "./ConversationsPanel";
import { FilesPanel } from "./FilesPanel";
import { Header } from "./Header";
import { LimitsPanel } from "./LimitsPanel";
import { LogPanel } from "./LogPanel";
import { ObjectivesPanel } from "./ObjectivesPanel";
import { RuntimePanel } from "./RuntimePanel";
import { SchedulePanel } from "./SchedulePanel";
import { TabBar } from "./TabBar";
import { TracePanel } from "./TracePanel";
import { TranscriptsPanel } from "./TranscriptsPanel";

type MainTab =
	| "objectives"
	| "files"
	| "transcripts"
	| "trace"
	| "limits"
	| "runtime"
	| "schedule"
	| "log"
	| "config";

const MAIN_TABS = [
	{ id: "objectives", label: "Objectives" },
	{ id: "files", label: "Files" },
	{ id: "transcripts", label: "Transcripts" },
	{ id: "trace", label: "Trace" },
	{ id: "limits", label: "Limits" },
	{ id: "runtime", label: "Runtime" },
	{ id: "schedule", label: "Schedule" },
	{ id: "config", label: "Config" },
	{ id: "log", label: "Log" },
] as const satisfies readonly { id: MainTab; label: string }[];

/** A "inspect turn →" deep link from Files or Trace into Transcripts. */
interface TurnJump {
	agent: string;
	turn: number;
}

/** One mission's cockpit: conversations on the left, the tabbed panels on the right. */
export function MissionDashboard({
	view,
}: {
	view: Extract<View, { kind: "ready" }>;
}) {
	const { mission, tree } = view;
	const {
		running: runningAgents,
		budgetPaused,
		agentError,
		dismissAgentError,
	} = useMissionStatus(mission);
	const [openAgent, setOpenAgent] = useState<string | null>(null);
	const [mainTab, setMainTab] = useState<MainTab>("objectives");
	const [turnJump, setTurnJump] = useState<TurnJump | null>(null);

	const inspectTurn = (agent: string, turn: number) => {
		setMainTab("transcripts");
		setTurnJump({ agent, turn });
	};

	return (
		<div className="app">
			<Header
				subtitle={`● live · updated ${new Date(view.updatedAt).toLocaleTimeString()}`}
				tree={tree}
				budgetPaused={budgetPaused}
				onBack={() => {
					window.location.search = "";
				}}
				missionId={mission ?? undefined}
			/>
			{agentError && mission && (
				<AgentErrorBanner
					error={agentError}
					missionId={mission}
					onDismiss={dismissAgentError}
				/>
			)}
			<div className="cols">
				<ConversationsPanel
					missionId={mission}
					openAgent={openAgent}
					onOpened={() => setOpenAgent(null)}
					runningAgents={runningAgents}
				/>
				<main className="col-main">
					<TabBar tabs={MAIN_TABS} value={mainTab} onChange={setMainTab} />
					<div className="tab-body">
						{mainTab === "objectives" && (
							<ObjectivesPanel
								tree={tree}
								missionId={mission}
								onAgentClick={setOpenAgent}
							/>
						)}
						{mainTab === "files" && (
							<FilesPanel missionId={mission} onInspectTurn={inspectTurn} />
						)}
						{mainTab === "transcripts" && (
							<TranscriptsPanel
								missionId={mission}
								jumpTo={turnJump}
								onJumped={() => setTurnJump(null)}
								runningAgents={runningAgents}
							/>
						)}
						{mainTab === "trace" && (
							<TracePanel missionId={mission} onInspectTurn={inspectTurn} />
						)}
						{mainTab === "limits" && <LimitsPanel missionId={mission} />}
						{mainTab === "runtime" && <RuntimePanel missionId={mission} />}
						{mainTab === "schedule" && <SchedulePanel missionId={mission} />}
						{mainTab === "config" && <ConfigPanel missionId={mission} />}
						{mainTab === "log" && <LogPanel missionId={mission} />}
					</div>
				</main>
			</div>
		</div>
	);
}
