/** Chart constants, palettes and the pure computations behind the Trace tab. */

import type { MessageEvent, TurnCost } from "../data";

export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
export const fmtCompact = (n: number) =>
	n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

// Sequential blue ramp (dataviz skill palette.md) — snap a 0..1 magnitude
// ratio to the nearest defined step. Exactly-zero is handled by the caller
// (rendered as neutral surface, not the palest ramp step) so "no data" never
// looks like "a very small value".
export const SEQ_STEPS = [
	"var(--seq-100)",
	"var(--seq-200)",
	"var(--seq-300)",
	"var(--seq-400)",
	"var(--seq-500)",
	"var(--seq-600)",
	"var(--seq-700)",
];
// A label sat inside a colored fill must pick its color by the fill's
// luminance to stay legible (marks-and-anatomy.md) — the top ramp steps are
// dark enough that fixed dark text would be illegible on them.
export const DARK_TEXT_FROM_STEP = 4; // --seq-500 and darker get white text
export function seqColor(ratio: number): { bg: string; fg: string } {
	const i = Math.min(
		SEQ_STEPS.length - 1,
		Math.round(ratio * (SEQ_STEPS.length - 1)),
	);
	return {
		bg: SEQ_STEPS[i],
		fg: i >= DARK_TEXT_FROM_STEP ? "#fff" : "var(--txt)",
	};
}

// Categorical palette (dataviz skill palette.md), fixed order — one color per
// agent, assigned by first appearance so it stays stable as data streams in.
export const CAT_COLORS = [
	"var(--cat-1)",
	"var(--cat-2)",
	"var(--cat-3)",
	"var(--cat-4)",
	"var(--cat-5)",
	"var(--cat-6)",
	"var(--cat-7)",
	"var(--cat-8)",
];

export const AGENTS_POLL_MS = 5000;
export const CHART_W = 760;
export const PAD_L = 56;
export const PAD_R = 16;
export const PAD_T = 12;
export const PLOT_H = 176;
export const PLOT_TOP = PAD_T;
export const PLOT_BOTTOM = PAD_T + PLOT_H;

// Event lanes below the cost plot — one row per marker type, sharing the
// plot's time axis. Order top-to-bottom is roughly "how often it fires":
// files and messages are frequent background activity; wakeups and
// anomalies are the rarer, more actionable signals, kept at the bottom
// nearest the reader's eye after scanning down from the cost lines.
export const LANE_H = 14;
export const LANE_ROW = LANE_H + 6;
export const LANES_TOP = PLOT_BOTTOM + 14;
export const LANE_DEFS = [
	{ key: "files", label: "Files" },
	{ key: "messages", label: "Messages" },
	{ key: "wakeups", label: "Wakeups" },
	{ key: "anomalies", label: "Anomalies" },
] as const;
export type LaneKey = (typeof LANE_DEFS)[number]["key"];
export const laneY = (key: LaneKey) =>
	LANES_TOP + LANE_DEFS.findIndex((l) => l.key === key) * LANE_ROW;

export const LANES_BOTTOM = LANES_TOP + LANE_DEFS.length * LANE_ROW - 6;

// Main plot's own x-axis tick labels — reflect the current zoom domain, not
// the mission's full range (that's the overview strip's job, below).
export const AXIS_LABEL_H = 16;
export const MAIN_AXIS_Y = LANES_BOTTOM + AXIS_LABEL_H - 4;

// Overview strip: always the mission's full time range, with a draggable
// brush to pick the sub-range the main plot zooms to. Mirrors the
// brush-to-zoom pattern in experimental/dump-trace.mjs (a separate, richer
// trace-viewer prototype than cockpit-mock.html's static renderTrace, which
// is what this component was originally ported from — the brush was lost in
// that port, not something that was never designed).
export const OVERVIEW_GAP = 12;
export const OVERVIEW_H = 26;
export const OVERVIEW_TOP = LANES_BOTTOM + AXIS_LABEL_H + OVERVIEW_GAP;
export const OVERVIEW_BOTTOM = OVERVIEW_TOP + OVERVIEW_H;
export const OVERVIEW_AXIS_Y = OVERVIEW_BOTTOM + 12;

export const CHART_H = OVERVIEW_AXIS_Y + 4;

// A drag shorter than this on the overview strip is treated as a click —
// i.e. "reset zoom" — rather than a (near-zero-width, useless) brush.
export const DRAG_CLICK_THRESHOLD_PX = 4;

// A turn box's natural width is its real [startedAt, completedAt] span at the
// current zoom — for most turns (minutes) against a chart spanning days or
// weeks, that's under 2px, i.e. entirely smaller than the 6px-diameter cost
// dot that sits at the box's right edge (the turn's end — same x as the dot,
// see the dots' `sx(p.t)` below). Below this floor the box was rendering
// completely hidden under its own dot, not merely thin — every turn except
// the rare one whose real duration happened to exceed a few pixels was
// invisible. Padded symmetrically around the box's true midpoint (not just
// widened rightward) so the visible part isn't always pinned to one side.
export const MIN_BOX_WIDTH_PX = 12;

/** The time range the chart covers: every turn's start and end and every message, never zero-width. */
export function fullTimeDomain(
	series: TurnCost[],
	messageEvents: MessageEvent[],
): [number, number] {
	const seriesTimes = series.flatMap((t) => [
		new Date(t.startedAt).getTime(),
		new Date(t.completedAt).getTime(),
	]);
	const eventTimes = messageEvents.map((m) => new Date(m.timestamp).getTime());
	const min = Math.min(...seriesTimes, ...eventTimes);
	return [min, Math.max(...seriesTimes, ...eventTimes, min + 1)];
}

export type CostPoint = { t: number; cum: number; turn?: TurnCost };
export type TurnBox = {
	turn: TurnCost;
	x1: number;
	x2: number;
	cumBefore: number;
};

/**
 * Per-agent step-after lines of cumulative cost (flat until a turn lands,
 * then a jump), each turn's box at its pre-jump level, and the largest total.
 * `sx` maps a timestamp to the chart's x coordinate at the current zoom.
 */
export function cumulativeCostLines(
	agents: string[],
	series: TurnCost[],
	[fullMinT, fullMaxT]: [number, number],
	sx: (t: number) => number,
): {
	perAgentLine: Map<string, CostPoint[]>;
	boxes: TurnBox[];
	maxCum: number;
} {
	const perAgentLine = new Map<string, CostPoint[]>();
	const boxes: TurnBox[] = [];
	let maxCum = 0;
	for (const agentId of agents) {
		const turns = series
			.filter((t) => t.agentId === agentId)
			.sort(
				(a, b) =>
					new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime(),
			);
		if (turns.length === 0) continue;
		const pts: CostPoint[] = [{ t: fullMinT, cum: 0 }];
		let cum = 0;
		for (const turn of turns) {
			const tStart = new Date(turn.startedAt).getTime();
			const tEnd = new Date(turn.completedAt).getTime();
			pts.push({ t: tEnd, cum }); // flat up to just before this turn lands
			boxes.push({ turn, x1: sx(tStart), x2: sx(tEnd), cumBefore: cum });
			cum += turn.costUsd;
			pts.push({ t: tEnd, cum, turn }); // step up
		}
		pts.push({ t: fullMaxT, cum }); // hold to the right edge
		perAgentLine.set(agentId, pts);
		maxCum = Math.max(maxCum, cum);
	}
	return { perAgentLine, boxes, maxCum: Math.max(maxCum, 1e-9) };
}
