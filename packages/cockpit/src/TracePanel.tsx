import { useEffect, useState } from "react";
import {
	type AgentMissionStats,
	fetchAgents,
	fetchCostSeries,
	fetchInteractions,
	fetchMessageEvents,
	fetchMissionStats,
	type Interaction,
	type MessageEvent,
	type TurnCost,
} from "./data";
import { LoadError, useLoadError } from "./load-error";
import { CostBars } from "./trace/CostBars";
import { CostTimeline } from "./trace/CostTimeline";
import { InteractionHeatmap } from "./trace/InteractionHeatmap";
import { StatTile } from "./trace/StatTile";
import { AGENTS_POLL_MS, fmtUsd } from "./trace/trace-geometry";

export function TracePanel({
	missionId,
	onInspectTurn,
}: {
	missionId: string | null;
	/** Jump to a turn's full transcript (Transcripts tab) — same deep link the Files panel uses. */
	onInspectTurn: (agent: string, turn: number) => void;
}) {
	const { loadError, failed } = useLoadError();
	const [agents, setAgents] = useState<string[]>([]);
	const [stats, setStats] = useState<AgentMissionStats[] | null>(null);
	const [interactions, setInteractions] = useState<Interaction[] | null>(null);
	const [costSeries, setCostSeries] = useState<TurnCost[] | null>(null);
	const [messageEvents, setMessageEvents] = useState<MessageEvent[] | null>(
		null,
	);

	useEffect(() => {
		if (!missionId) return;
		const loadAgents = () =>
			fetchAgents(missionId).then(
				(as) => setAgents(as.map((a) => a.id)),
				failed("Loading the roster"),
			);
		loadAgents();
		// Poll rather than fetch once — see ConversationsPanel's identical fix
		// (github#26): a one-shot fetch landing right after a daemon crash
		// restart can cache a roster missing the mission-copilot for the rest
		// of the session.
		const t = setInterval(loadAgents, AGENTS_POLL_MS);
		return () => clearInterval(t);
	}, [missionId, failed]);

	useEffect(() => {
		if (!missionId) return;
		fetchMissionStats(missionId).then(setStats, failed("Loading stats"));
		fetchInteractions(missionId).then(setInteractions, () =>
			setInteractions([]),
		);
		fetchCostSeries(missionId).then(
			setCostSeries,
			failed("Loading the cost series"),
		);
		fetchMessageEvents(missionId).then(setMessageEvents, () =>
			setMessageEvents([]),
		);
	}, [missionId, failed]);

	if (!missionId)
		return <p className="mut">Select a live mission to see its trace.</p>;
	if (
		stats === null ||
		interactions === null ||
		costSeries === null ||
		messageEvents === null
	)
		return <p className="mut">Loading…</p>;

	const totalCost = stats.reduce((a, s) => a + s.lifetimeCostUsd, 0);
	const totalTurns = stats.reduce((a, s) => a + s.lifetimeTurnCount, 0);
	const totalCalls = stats.reduce((a, s) => a + s.lifetimeLlmCallCount, 0);

	// Agent-to-agent interactions only (excludes "user"/copilot channels,
	// already visible in the Conversations rail) — the novel signal here is
	// coordination between mission agents.
	const agentInteractions = interactions.filter(
		(i) => agents.includes(i.from) && agents.includes(i.to),
	);

	return (
		<div className="trace">
			<LoadError message={loadError} />
			<div className="stat-row">
				<StatTile label="Mission cost" value={fmtUsd(totalCost)} />
				<StatTile label="Turns" value={String(totalTurns)} />
				<StatTile label="LLM calls" value={String(totalCalls)} />
			</div>
			<CostTimeline
				agents={agents}
				series={costSeries}
				messageEvents={messageEvents}
				onInspectTurn={onInspectTurn}
			/>
			<CostBars stats={stats} />
			<InteractionHeatmap agents={agents} interactions={agentInteractions} />
		</div>
	);
}
