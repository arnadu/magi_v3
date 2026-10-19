import type { MessageEvent, TurnCost } from "../data";
import { inspectKeyHandler } from "./inspect-key";
import {
	CHART_W,
	LANE_DEFS,
	LANE_H,
	laneY,
	PAD_L,
	PAD_R,
} from "./trace-geometry";

/** The marker lanes under the cost plot: files written, messages, scheduled wakeups, aborted turns. */
export function EventLanes({
	agents,
	series,
	messageEvents,
	sx,
	colorOf,
	onInspectTurn,
}: {
	agents: string[];
	series: TurnCost[];
	messageEvents: MessageEvent[];
	sx: (t: number) => number;
	colorOf: (agentId: string) => string;
	onInspectTurn: (agent: string, turn: number) => void;
}) {
	const fileTurns = series.filter((t) => (t.gitChangedFiles?.length ?? 0) > 0);
	const anomalyTurns = series.filter((t) => t.status === "aborted");
	const wakeupEvents = messageEvents.filter((m) => m.from === "scheduler");
	const agentMessageEvents = messageEvents.filter(
		(m) => m.from !== "scheduler",
	);
	return (
		<>
			{LANE_DEFS.map((lane) => (
				<g key={lane.key}>
					<text
						x={PAD_L - 8}
						y={laneY(lane.key) + LANE_H / 2 + 3}
						className="chart-axis chart-lane-label"
						textAnchor="end"
					>
						{lane.label}
					</text>
					<line
						x1={PAD_L}
						x2={CHART_W - PAD_R}
						y1={laneY(lane.key) + LANE_H / 2}
						y2={laneY(lane.key) + LANE_H / 2}
						className="chart-grid"
					/>
				</g>
			))}

			{fileTurns.map((t) => (
				// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; see the turn-box rect above
				<circle
					key={`file-${t.agentId}-${t.turnNumber}`}
					className="trace-mark"
					cx={sx(new Date(t.completedAt).getTime())}
					cy={laneY("files") + LANE_H / 2}
					r={3.5}
					fill={colorOf(t.agentId)}
					role="button"
					tabIndex={0}
					onClick={() => onInspectTurn(t.agentId, t.turnNumber)}
					onKeyDown={inspectKeyHandler(onInspectTurn, t.agentId, t.turnNumber)}
				>
					<title>
						{`${t.agentId} · turn ${t.turnNumber} wrote ${t.gitChangedFiles?.length} file${t.gitChangedFiles?.length === 1 ? "" : "s"}: ${t.gitChangedFiles?.map((f) => f.path).join(", ")} — click to inspect`}
					</title>
				</circle>
			))}
			{agentMessageEvents.map((m, i) => (
				<circle
					// biome-ignore lint/suspicious/noArrayIndexKey: messages have no stable id from the API
					key={`msg-${i}`}
					cx={sx(new Date(m.timestamp).getTime())}
					cy={laneY("messages") + LANE_H / 2}
					r={3.5}
					fill={agents.includes(m.from) ? colorOf(m.from) : "var(--dim)"}
				>
					<title>
						{`${m.from} → ${m.to.join(", ")}: ${m.subject || "(no subject)"} · ${new Date(m.timestamp).toLocaleString()}`}
					</title>
				</circle>
			))}
			{wakeupEvents.map((m, i) => (
				<circle
					// biome-ignore lint/suspicious/noArrayIndexKey: messages have no stable id from the API
					key={`wake-${i}`}
					cx={sx(new Date(m.timestamp).getTime())}
					cy={laneY("wakeups") + LANE_H / 2}
					r={3.5}
					fill="var(--info)"
				>
					<title>
						{`Scheduled wakeup → ${m.to.join(", ")}: ${m.subject || "(no subject)"} · ${new Date(m.timestamp).toLocaleString()}`}
					</title>
				</circle>
			))}
			{anomalyTurns.map((t) => (
				// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; see the turn-box rect above
				<circle
					key={`anomaly-${t.agentId}-${t.turnNumber}`}
					className="trace-mark"
					cx={sx(new Date(t.completedAt).getTime())}
					cy={laneY("anomalies") + LANE_H / 2}
					r={3.5}
					fill="var(--bad)"
					role="button"
					tabIndex={0}
					onClick={() => onInspectTurn(t.agentId, t.turnNumber)}
					onKeyDown={inspectKeyHandler(onInspectTurn, t.agentId, t.turnNumber)}
				>
					<title>
						{`${t.agentId} · turn ${t.turnNumber} aborted · ${new Date(t.completedAt).toLocaleString()} — click to inspect`}
					</title>
				</circle>
			))}
		</>
	);
}
