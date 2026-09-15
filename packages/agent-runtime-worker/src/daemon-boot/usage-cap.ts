import { UsageAccumulator } from "../usage.js";
import type { BootContext } from "./context.js";

/**
 * Session-only usage accumulator (for the console log line and the SSE live
 * ticker — never checked against a limit, see usage.ts's own header) plus
 * the boot-time spending-cap fallback. The mission's own persisted config is
 * the live source of truth (ADR-0018 — read fresh from MongoDB on every
 * check, in main()'s onAgentMessage callback); this value is used ONLY when
 * a live read transiently fails or no cap is configured at all.
 *
 * Exits the process directly (not a discriminated return) on an invalid
 * MAX_COST_USD: this mirrors the original inline code's bare process.exit(1),
 * which never needs to unwind back through main()'s scope.
 */
export function resolveUsageAndCap(
	ctx: Pick<BootContext, "teamConfig">,
): Pick<BootContext, "usageAccumulator" | "maxCostUsd"> {
	const usageAccumulator = new UsageAccumulator();
	let maxCostUsd: number | null = ctx.teamConfig.mission.maxCostUsd ?? null;
	let maxCostUsdSource = "mission config";
	if (maxCostUsd === null && process.env.MAX_COST_USD) {
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
	if (maxCostUsd !== null) {
		console.log(
			`[daemon] Spending cap: $${maxCostUsd.toFixed(2)} (from ${maxCostUsdSource})`,
		);
	}
	return { usageAccumulator, maxCostUsd };
}
