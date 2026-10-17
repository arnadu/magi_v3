import { useEffect, useState } from "react";
import { fetchCatalog, type ToggleCatalog } from "./data";

const EMPTY: ToggleCatalog = { platformSkills: [], tierATools: [] };
let cached: Promise<ToggleCatalog> | null = null;

/**
 * The skill and tool names the server says exist. Fetched once per page; a
 * failure leaves the lists empty and reports it (the editor then offers only
 * the mission's own team skills) rather than guessing a stale hard-coded set.
 */
export function useCatalog(): {
	catalog: ToggleCatalog;
	catalogError: string | null;
} {
	const [catalog, setCatalog] = useState<ToggleCatalog>(EMPTY);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		cached ??= fetchCatalog();
		cached.then(
			(c) => {
				if (live) setCatalog(c);
			},
			(e) => {
				cached = null;
				if (live)
					setCatalogError(
						`Loading the skill/tool list failed: ${(e as Error).message}`,
					);
			},
		);
		return () => {
			live = false;
		};
	}, []);
	return { catalog, catalogError };
}
