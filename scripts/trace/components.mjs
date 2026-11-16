// The component map: every component of the catalog placed by its plane and
// declared layer, sized by its lines of code, with the imports between
// components counted from the sources. An import of a component on the same
// or a higher layer of the same plane runs against the layering.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANES = ["control-plane", "mission-machine", "browser"];
const W = 128;
const H = 44;
const GAP = 12;
const ROW = 62;

function walk(dir) {
	const out = [];
	for (const f of readdirSync(dir)) {
		if (f === "node_modules" || f === "dist") continue;
		const p = join(dir, f);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|tsx)$/.test(p)) out.push(p);
	}
	return out;
}

/** Lines per component and import counts between components, from the sources. */
export function componentImports(b, root) {
	const pkgIndex = (pkg) => join(root, "packages", pkg, "src/index.ts");
	// Names re-exported by a package's index, to the file that defines them.
	const exportsOf = new Map();
	for (const pkg of ["agent-runtime-worker", "agent-config"]) {
		const idx = pkgIndex(pkg);
		const map = new Map();
		for (const m of readFileSync(idx, "utf8").matchAll(
			/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]+)"/g,
		))
			for (const n of m[1].split(",")) {
				const name = n
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)
					.pop();
				if (name)
					map.set(
						name,
						relative(root, join(dirname(idx), m[2].replace(/\.js$/, ".ts"))),
					);
			}
		exportsOf.set(`@magi/${pkg}`, { map, index: relative(root, idx) });
	}
	const sizes = new Map();
	const edges = new Map();
	const roots = [...new Set(b.COMPONENTS.map((c) => c.root))];
	for (const r of roots) {
		if (!existsSync(join(root, r))) continue;
		for (const abs of walk(join(root, r))) {
			const rel = relative(root, abs);
			const [from] = b.componentsOwning(rel);
			if (!from) continue;
			const text = readFileSync(abs, "utf8");
			sizes.set(from, (sizes.get(from) ?? 0) + text.split("\n").length);
			for (const m of text.matchAll(
				/(?:import|export)\s+(?:type\s+)?(?:\{([^}]*)\}|[\w*\s,]+)?\s*from\s+"([^"]+)"/g,
			)) {
				const spec = m[2];
				let targets = [];
				if (spec.startsWith(".")) {
					let t = resolve(dirname(abs), spec.replace(/\.js$/, ".ts"));
					if (!existsSync(t)) t = t.replace(/\.ts$/, ".tsx");
					if (!existsSync(t)) t = resolve(dirname(abs), spec, "index.ts");
					targets = [relative(root, t)];
				} else if (exportsOf.has(spec)) {
					const { map, index } = exportsOf.get(spec);
					const names = (m[1] ?? "")
						.split(",")
						.map(
							(n) =>
								n
									.trim()
									.replace(/^type\s+/, "")
									.split(/\s+as\s+/)[0],
						)
						.filter(Boolean);
					targets = names.length
						? names.map((n) => map.get(n) ?? index)
						: [index];
				} else continue;
				for (const t of targets) {
					const [to] = b.componentsOwning(t);
					if (!to || to === from) continue;
					const k = `${from}>${to}`;
					edges.set(k, (edges.get(k) ?? 0) + 1);
				}
			}
		}
	}
	return {
		sizes: Object.fromEntries(sizes),
		edges: [...edges].map(([k, n]) => [...k.split(">"), n]),
	};
}

/** Positions: one column per plane, one row per layer (highest on top). */
function layout(b) {
	const pos = {};
	let x0 = 20;
	const top = 40;
	const maxLayer = Math.max(...b.COMPONENTS.map((c) => c.layer));
	const planes = [];
	for (const plane of PLANES) {
		const comps = b.COMPONENTS.filter((c) => c.plane === plane);
		const layers = [...new Set(comps.map((c) => c.layer))];
		const widest = Math.max(
			...layers.map((l) => comps.filter((c) => c.layer === l).length),
		);
		const width = widest * (W + GAP) - GAP;
		for (const l of layers) {
			const row = comps.filter((c) => c.layer === l);
			const rowWidth = row.length * (W + GAP) - GAP;
			row.forEach((c, i) => {
				pos[c.id] = [
					x0 + (width - rowWidth) / 2 + i * (W + GAP),
					top + (maxLayer - l) * ROW,
				];
			});
		}
		planes.push({ plane, x: x0, width });
		x0 += width + 48;
	}
	const bandY = top + maxLayer * ROW + 20;
	return {
		pos,
		planes,
		band: { x: 20, y: bandY, w: x0 - 68, h: 42 },
		width: x0 - 28,
		height: bandY + 62,
	};
}

/** Imports that run against the layering: same plane, same or higher layer. */
export function againstLayering(b, edges) {
	const c = new Map(b.COMPONENTS.map((x) => [x.id, x]));
	return edges.filter(([a, t]) => {
		const from = c.get(a);
		const to = c.get(t);
		return (
			from &&
			to &&
			from.plane === to.plane &&
			from.layer > 0 &&
			to.layer >= from.layer
		);
	});
}

export function renderComponentMap(meta, b, imports) {
	const { sizes, edges } = imports;
	const geo = layout(b);
	const against = againstLayering(b, edges);
	const planeOf = new Map(b.COMPONENTS.map((c) => [c.id, c.plane]));
	const cross = {};
	for (const [a, t, n] of edges) {
		const pa = planeOf.get(a);
		const pt = planeOf.get(t);
		if (pa !== pt && pt !== "shared")
			cross[`${pa} → ${pt}`] = (cross[`${pa} → ${pt}`] ?? 0) + n;
	}
	const data = {
		meta,
		comps: b.COMPONENTS.map((c) => ({
			id: c.id,
			plane: c.plane,
			layer: c.layer,
			name: c.name,
			resp: c.responsibility,
			lines: sizes[c.id] ?? 0,
		})),
		edges,
		against,
		cross,
		geo,
		box: { w: W, h: H },
	};
	const template = readFileSync(join(HERE, "components-template.html"), "utf8");
	return template.replace(
		"__DATA__",
		JSON.stringify(data).replace(/</g, "\\u003c"),
	);
}
