import type { TurnCost } from "../data";
import { inspectKeyHandler } from "./inspect-key";
import {
	type CostPoint,
	fmtCompact,
	fmtUsd,
	MIN_BOX_WIDTH_PX,
	type TurnBox,
} from "./trace-geometry";

// Box height scales with how many LLM calls happened in the turn (min 6,
// max 22px) — a busy turn reads as a visibly chunkier box than a
// single-call one, without needing the per-call llmCallLog data.
const boxHeight = (llmCallCount: number) =>
	Math.min(22, Math.max(6, 5 + llmCallCount * 1.5));

/** Each agent's cumulative cost line, its turn boxes and the clickable turn dots. */
export function CostMarks({
	perAgentLine,
	boxes,
	sx,
	sy,
	colorOf,
	onInspectTurn,
}: {
	perAgentLine: Map<string, CostPoint[]>;
	boxes: TurnBox[];
	sx: (t: number) => number;
	sy: (v: number) => number;
	colorOf: (agentId: string) => string;
	onInspectTurn: (agent: string, turn: number) => void;
}) {
	return (
		<>
			{[...perAgentLine.entries()].map(([agentId, pts]) => (
				<polyline
					key={agentId}
					fill="none"
					stroke={colorOf(agentId)}
					strokeWidth={2}
					points={pts.map((p) => `${sx(p.t)},${sy(p.cum)}`).join(" ")}
				/>
			))}
			{boxes.map((b) => {
				const h = boxHeight(b.turn.llmCallCount);
				const y = sy(b.cumBefore);
				const aborted = b.turn.status === "aborted";
				const natW = b.x2 - b.x1;
				const w = Math.max(MIN_BOX_WIDTH_PX, natW);
				const x = (b.x1 + b.x2) / 2 - w / 2;
				return (
					// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; role="button" + tabIndex + onKeyDown is the WAI-ARIA-recommended pattern for a clickable non-form SVG element
					<rect
						key={`${b.turn.agentId}-${b.turn.turnNumber}`}
						className="trace-mark"
						x={x}
						y={y - h / 2}
						width={w}
						height={h}
						rx={2}
						fill={colorOf(b.turn.agentId)}
						fillOpacity={0.25}
						stroke={aborted ? "var(--bad)" : colorOf(b.turn.agentId)}
						strokeWidth={aborted ? 1.5 : 1}
						strokeDasharray={aborted ? "3 2" : undefined}
						role="button"
						tabIndex={0}
						onClick={() => onInspectTurn(b.turn.agentId, b.turn.turnNumber)}
						onKeyDown={inspectKeyHandler(
							onInspectTurn,
							b.turn.agentId,
							b.turn.turnNumber,
						)}
					>
						<title>
							{`${b.turn.agentId} · turn ${b.turn.turnNumber} · ${b.turn.llmCallCount} LLM call${b.turn.llmCallCount === 1 ? "" : "s"} · peak ctx ${fmtCompact(b.turn.peakContextTokens)} · ${fmtUsd(b.turn.costUsd)}${aborted ? " · ABORTED" : ""} — click to inspect`}
						</title>
					</rect>
				);
			})}
			{[...perAgentLine.entries()].flatMap(([agentId, pts]) =>
				pts
					.filter(
						(p): p is CostPoint & { turn: TurnCost } => p.turn !== undefined,
					)
					.map((p) => (
						// biome-ignore lint/a11y/useSemanticElements: SVG has no <button> equivalent for a shape; see the turn-box rect above
						<circle
							key={`${agentId}-${p.turn.turnNumber}-dot`}
							className="trace-mark"
							cx={sx(p.t)}
							cy={sy(p.cum)}
							r={3}
							fill={colorOf(agentId)}
							stroke="var(--panel)"
							strokeWidth={1.5}
							role="button"
							tabIndex={0}
							onClick={() => onInspectTurn(agentId, p.turn.turnNumber)}
							onKeyDown={inspectKeyHandler(
								onInspectTurn,
								agentId,
								p.turn.turnNumber,
							)}
						>
							<title>
								{`${agentId} · turn ${p.turn.turnNumber} · ${fmtUsd(p.turn.costUsd)} (cumulative ${fmtUsd(p.cum)}) · ${new Date(p.turn.completedAt).toLocaleString()} — click to inspect`}
							</title>
						</circle>
					)),
			)}
		</>
	);
}
