/** Plain-text rendering of the daily resource report (wording is judged by reading, not asserted). */

import {
	type DailyReport,
	formatShape,
	gb,
	hours,
	type MissionReportRow,
	mb,
	minutesAgo,
} from "./resource-report-types.js";

/** Renders a `DailyReport` as plain text for the copilot's mailbox. */
export function renderDailyReport(report: DailyReport): string {
	return [
		`Daily resource report — ${report.date} (last 24 h)`,
		"",
		...flagLines(report),
		"",
		...atlasLines(report),
		"MISSIONS",
		...(report.missions.length === 0 ? ["  (none)"] : []),
		...report.missions.map((m) => missionLine(m, report.generatedAt)),
		...upgradeLines(report),
	].join("\n");
}

function flagLines(report: DailyReport): string[] {
	if (report.flags.length === 0) return ["FLAGS: none — all clear"];
	return [
		`FLAGS (${report.flags.length})`,
		...report.flags.map((f) => `  ! ${f.label} [${f.scope}]  ${f.detail}`),
	];
}

function atlasLines(report: DailyReport): string[] {
	const atlas = report.atlas;
	if (!atlas) return [];
	const pct = Math.round((atlas.usedBytes / atlas.limitBytes) * 100);
	const growth =
		atlas.growthBytesPerDay !== undefined
			? `, +${mb(atlas.growthBytesPerDay)} MB/24h`
			: "";
	const top = atlas.collections
		.slice(0, 5)
		.map((c) => `${c.name} ${mb(c.bytes)} MB`)
		.join(" · ");
	return [
		"PLATFORM",
		`  MongoDB Atlas   ${mb(atlas.usedBytes)} / ${mb(atlas.limitBytes)} MB (${pct}%)${growth}`,
		...(top ? [`    top collections: ${top}`] : []),
		"",
	];
}

function missionLine(m: MissionReportRow, generatedAt: Date): string {
	const cap = m.llmCapUsd !== undefined ? ` / $${m.llmCapUsd.toFixed(2)}` : "";
	const disk =
		m.diskUsedBytes !== undefined && m.diskTotalBytes !== undefined
			? `${gb(m.diskUsedBytes)} / ${gb(m.diskTotalBytes)} GB`
			: "no sample";
	const activity = m.lastActivityAt
		? minutesAgo(m.lastActivityAt, generatedAt)
		: "never";
	return `  ${m.missionId} (${m.status})  LLM 24h $${m.llm24hUsd.toFixed(2)}  total $${m.llmTotalUsd.toFixed(2)}${cap}  machine ${formatShape(m.shape)}${m.upgraded ? " [upgraded]" : ""}  upgraded ${hours(m.upgradedMsSinceReset)}h / ${hours(m.upgradedCapMs)}h cap  disk ${disk}  last activity ${activity}`;
}

/** The ADR-0031 dataset: upgraded time in the last day and the upgrades active now. */
function upgradeLines(report: DailyReport): string[] {
	const total = report.missions.reduce((sum, m) => sum + m.upgradedMs24h, 0);
	const active = report.missions.filter((m) => m.upgraded);
	if (total === 0 && active.length === 0) return [];
	return [
		"",
		"UPGRADES (ADR-0031 dataset)",
		`  Total upgraded time in the last 24h: ${hours(total)}h`,
		...active.map((m) => {
			const expiresIn = m.activeUpgradeExpiresAt
				? Math.round(
						(m.activeUpgradeExpiresAt.getTime() -
							report.generatedAt.getTime()) /
							60_000,
					)
				: undefined;
			return `  Active now: ${m.missionId} (${formatShape(m.shape)})${expiresIn !== undefined ? `, expires in ${expiresIn} min` : ""}`;
		}),
	];
}
