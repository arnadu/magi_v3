import { DEFAULT_MISSION_MAX_COST_USD } from "@magi/agent-config";
import { UsageAccumulator } from "../usage.js";
import type { BootContext } from "./context.js";

/**
 * Session-only usage accumulator (for the console log line and the SSE live
 * ticker — never checked against a limit, see usage.ts's own header) plus
 * the boot-time spending-cap fallback. The mission's own persisted config is
 * the live source of truth (ADR-0018 — read fresh from MongoDB on every
 * check, in main()'s onAgentMessage callback); this value is used ONLY when
 * a live read transiently fails or the live config has no cap.
 *
 * There is always a cap (SCH-4): the mission's, else MAX_COST_USD, else the
 * platform default. A mission document without one is a defect upstream
 * (every config write sets it), but the daemon never runs uncapped because
 * of it.
 *
 * Exits the process directly (not a discriminated return) on an invalid
 * MAX_COST_USD: this mirrors the original inline code's bare process.exit(1),
 * which never needs to unwind back through main()'s scope.
 */
export function resolveUsageAndCap(
	ctx: Pick<BootContext, "teamConfig">,
): Pick<BootContext, "usageAccumulator" | "maxCostUsd"> {
	const usageAccumulator = new UsageAccumulator();
	let maxCostUsd = ctx.teamConfig.mission.maxCostUsd;
	let maxCostUsdSource = "mission config";
	if (maxCostUsd === undefined && process.env.MAX_COST_USD) {
		const v = Number.parseFloat(process.env.MAX_COST_USD);
		if (!Number.isFinite(v) || v <= 0) {
			console.error(
				`Error: MAX_COST_USD must be a positive number, got: ${process.env.MAX_COST_USD}`,
			);
			process.exit(1);
		}
		maxCostUsd = v;
		maxCostUsdSource = "MAX_COST_USD env var";
	}
	if (maxCostUsd === undefined) {
		maxCostUsd = DEFAULT_MISSION_MAX_COST_USD;
		maxCostUsdSource = "platform default — the mission config sets no cap";
		console.warn(
			`[daemon] Mission config has no spend cap; enforcing the default $${maxCostUsd.toFixed(2)} until one is set`,
		);
	}
	console.log(
		`[daemon] Spending cap: $${maxCostUsd.toFixed(2)} (from ${maxCostUsdSource})`,
	);
	return { usageAccumulator, maxCostUsd };
}
