/**
 * Machine shapes for temporary upgrades (ADR-0031): which CPU kind / CPU
 * count / RAM combinations Fly accepts, which of those an agent may request
 * (maximum size and mandatory duration), and a display-only price estimate.
 *
 * Pure: no I/O. The Fly validity rules come from Fly's pricing page (there is
 * no API for them) and must be re-checked if Fly changes its catalogue — the
 * upgrade route surfaces Fly's own error verbatim if a shape we accept is
 * ever rejected. Prices are only ever shown as an estimate, never enforced.
 */

import { UPGRADE_LIMITS } from "@magi/agent-runtime-worker";

export type CpuKind = "shared" | "performance";

export interface MachineShape {
	cpuKind: CpuKind;
	cpus: number;
	memoryMb: number;
}

export interface UpgradeRequest extends MachineShape {
	durationMinutes: number;
}

/** The machine every mission runs on unless `mission.memoryMb`/`cpus` say otherwise. */
export const DEFAULT_MACHINE: MachineShape = {
	cpuKind: "shared",
	cpus: 1,
	memoryMb: 1024,
};

const MEMORY_STEP_MB = 256;

const VALID_CPUS: Record<CpuKind, readonly number[]> = {
	shared: [1, 2, 4, 6, 8],
	performance: [1, 2, 4, 6, 8, 10, 12, 14, 16],
};

/** RAM allowed per CPU, in MB: shared 256 MB – 2 GB, performance 2 – 8 GB. */
const MEMORY_PER_CPU_MB: Record<CpuKind, { min: number; max: number }> = {
	shared: { min: 256, max: 2048 },
	performance: { min: 2048, max: 8192 },
};

/** Fly's valid RAM range for a shape, before the upgrade size limit; null for an invalid CPU count. */
function flyMemoryRange(
	cpuKind: CpuKind,
	cpus: number,
): { minMb: number; maxMb: number } | null {
	if (!VALID_CPUS[cpuKind].includes(cpus)) return null;
	const per = MEMORY_PER_CPU_MB[cpuKind];
	return { minMb: per.min * cpus, maxMb: per.max * cpus };
}

/** RAM range an agent may request for (cpuKind, cpus): Fly's range capped by the upgrade limits; null if not allowed at all. */
export function allowedMemoryRange(
	cpuKind: CpuKind,
	cpus: number,
): { minMb: number; maxMb: number } | null {
	if (cpus > UPGRADE_LIMITS.maxCpus) return null;
	const fly = flyMemoryRange(cpuKind, cpus);
	if (!fly) return null;
	const maxMb = Math.min(fly.maxMb, UPGRADE_LIMITS.maxMemoryMb);
	return maxMb < fly.minMb ? null : { minMb: fly.minMb, maxMb };
}

/** Human/LLM-readable list of every shape an agent may request. Used in error messages. */
export function describeAllowedShapes(): string {
	const parts = (Object.keys(VALID_CPUS) as CpuKind[]).map((kind) => {
		const rows = VALID_CPUS[kind].flatMap((cpus) => {
			const range = allowedMemoryRange(kind, cpus);
			return range
				? [
						`${cpus} CPU${cpus === 1 ? "" : "s"} ${range.minMb}–${range.maxMb} MB`,
					]
				: [];
		});
		return `${kind}: ${rows.join("; ")}`;
	});
	return `${parts.join(". ")}. RAM in steps of ${MEMORY_STEP_MB} MB.`;
}

export type ShapeValidation =
	| { ok: true; request: UpgradeRequest }
	| { ok: false; error: string };

function isInt(v: unknown): v is number {
	return typeof v === "number" && Number.isInteger(v);
}

/**
 * Validate an untrusted upgrade request body. Rejects rather than clamps:
 * every problem is reported at once, followed by the valid options, so the
 * caller (an LLM) can correct the whole request in one retry. The duration is
 * mandatory — there is deliberately no default.
 */
export function validateUpgradeRequest(input: unknown): ShapeValidation {
	const errors: string[] = [];
	const body =
		typeof input === "object" && input !== null
			? (input as Record<string, unknown>)
			: {};
	const { cpuKind, cpus, memoryMb, durationMinutes } = body;

	const kindOk = cpuKind === "shared" || cpuKind === "performance";
	if (!kindOk) errors.push(`cpuKind must be "shared" or "performance"`);

	if (!isInt(cpus) || cpus < 1) {
		errors.push("cpus must be a positive integer");
	} else if (cpus > UPGRADE_LIMITS.maxCpus) {
		errors.push(
			`cpus ${cpus} exceeds the maximum of ${UPGRADE_LIMITS.maxCpus}`,
		);
	} else if (kindOk && !VALID_CPUS[cpuKind].includes(cpus)) {
		errors.push(`${cpus} CPUs is not offered for ${cpuKind}`);
	}

	if (!isInt(memoryMb)) {
		errors.push("memoryMb must be an integer number of MB");
	} else if (memoryMb % MEMORY_STEP_MB !== 0) {
		errors.push(`memoryMb ${memoryMb} must be a multiple of ${MEMORY_STEP_MB}`);
	} else if (kindOk && isInt(cpus)) {
		const range = allowedMemoryRange(cpuKind, cpus);
		if (range && (memoryMb < range.minMb || memoryMb > range.maxMb)) {
			errors.push(
				`memoryMb ${memoryMb} is outside ${range.minMb}–${range.maxMb} MB for ${cpuKind} with ${cpus} CPU${cpus === 1 ? "" : "s"}`,
			);
		}
	}

	if (
		!isInt(durationMinutes) ||
		durationMinutes < 1 ||
		durationMinutes > UPGRADE_LIMITS.maxWindowMinutes
	) {
		errors.push(
			`durationMinutes is required (there is no default) and must be an integer from 1 to ${UPGRADE_LIMITS.maxWindowMinutes}`,
		);
	}

	if (errors.length > 0) {
		return {
			ok: false,
			error: `Invalid upgrade request: ${errors.join("; ")}. Allowed shapes — ${describeAllowedShapes()}`,
		};
	}
	return {
		ok: true,
		request: {
			cpuKind: cpuKind as CpuKind,
			cpus: cpus as number,
			memoryMb: memoryMb as number,
			durationMinutes: durationMinutes as number,
		},
	};
}

export function sameShape(a: MachineShape, b: MachineShape): boolean {
	return (
		a.cpuKind === b.cpuKind && a.cpus === b.cpus && a.memoryMb === b.memoryMb
	);
}

// ---------------------------------------------------------------------------
// Price estimate (display only — never used for enforcement)
// ---------------------------------------------------------------------------

/** USD per second per CPU at the preset's base RAM, from Fly's pricing page. */
const CPU_USD_PER_SECOND: Record<CpuKind, number> = {
	shared: 0.00000078,
	performance: 0.00001242,
};

/** RAM included in the per-CPU price, in MB. */
const BASE_MEMORY_PER_CPU_MB: Record<CpuKind, number> = {
	shared: 256,
	performance: 2048,
};

/** Fly charges about $5 per 30 days for each GB above the preset's base RAM. */
const EXTRA_RAM_USD_PER_GB_SECOND = 0.000002;

export function estimateCostPerHourUsd(shape: MachineShape): number {
	const base = CPU_USD_PER_SECOND[shape.cpuKind] * shape.cpus;
	const baseMb = BASE_MEMORY_PER_CPU_MB[shape.cpuKind] * shape.cpus;
	const extraGb = Math.max(0, shape.memoryMb - baseMb) / 1024;
	return (base + extraGb * EXTRA_RAM_USD_PER_GB_SECOND) * 3600;
}

// ---------------------------------------------------------------------------
// Menu (shown to agents in the request-resources skill)
// ---------------------------------------------------------------------------

export interface MenuEntry {
	name: string;
	shape: MachineShape;
	costPerHourUsd: number;
}

const MENU: ReadonlyArray<{ name: string; shape: MachineShape }> = [
	{
		name: "memory, small",
		shape: { cpuKind: "shared", cpus: 1, memoryMb: 2048 },
	},
	{
		name: "memory, medium",
		shape: { cpuKind: "shared", cpus: 2, memoryMb: 4096 },
	},
	{
		name: "memory, large",
		shape: { cpuKind: "shared", cpus: 4, memoryMb: 8192 },
	},
	{
		name: "compute, small",
		shape: { cpuKind: "performance", cpus: 1, memoryMb: 4096 },
	},
	{
		name: "compute, medium",
		shape: { cpuKind: "performance", cpus: 2, memoryMb: 8192 },
	},
	{
		name: "compute, large",
		shape: { cpuKind: "performance", cpus: 4, memoryMb: 16_384 },
	},
];

/** The common upgrade shapes with estimated hourly cost, cheapest-first within each family. */
export function buildMenu(): MenuEntry[] {
	return MENU.map(({ name, shape }) => ({
		name,
		shape,
		costPerHourUsd: estimateCostPerHourUsd(shape),
	}));
}
