import {
	CHART_W,
	fmtUsd,
	PAD_L,
	PAD_R,
	PLOT_BOTTOM,
	PLOT_TOP,
} from "./trace-geometry";

/** Y gridlines with dollar labels, and the plot's two axis lines. */
export function CostAxes({
	yTicks,
	sy,
}: {
	yTicks: number[];
	sy: (v: number) => number;
}) {
	return (
		<>
			{yTicks.map((v) => (
				<g key={v}>
					<line
						x1={PAD_L}
						x2={CHART_W - PAD_R}
						y1={sy(v)}
						y2={sy(v)}
						className="chart-grid"
					/>
					<text
						x={PAD_L - 8}
						y={sy(v) + 3}
						className="chart-axis"
						textAnchor="end"
					>
						{fmtUsd(v)}
					</text>
				</g>
			))}
			<line
				x1={PAD_L}
				x2={PAD_L}
				y1={PLOT_TOP}
				y2={PLOT_BOTTOM}
				className="chart-axis-line"
			/>
			<line
				x1={PAD_L}
				x2={CHART_W - PAD_R}
				y1={PLOT_BOTTOM}
				y2={PLOT_BOTTOM}
				className="chart-axis-line"
			/>
		</>
	);
}
