import { useCallback, useEffect, useState } from "react";

export type Resource<T> =
	| { status: "loading" }
	| { status: "ready"; data: T }
	| { status: "error"; message: string };

/**
 * Load `load(key)` when `key` changes and again on `reload()`. A response for
 * an earlier key or an earlier reload is dropped, so a slow answer never
 * overwrites a newer one. A null key loads nothing (the panel says why).
 * The error keeps the server's message (`request()` puts it on the Error).
 */
export function useApiResource<T>(
	key: string | null,
	load: (key: string) => Promise<T>,
): { resource: Resource<T>; reload: () => void } {
	const [resource, setResource] = useState<Resource<T>>({ status: "loading" });
	const [generation, setGeneration] = useState(0);
	const reload = useCallback(() => setGeneration((g) => g + 1), []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: generation is a refetch trigger; load is the caller's stable fetcher
	useEffect(() => {
		if (!key) return;
		let current = true;
		setResource({ status: "loading" });
		load(key).then(
			(data) => {
				if (current) setResource({ status: "ready", data });
			},
			(e: unknown) => {
				if (current)
					setResource({ status: "error", message: (e as Error).message });
			},
		);
		return () => {
			current = false;
		};
	}, [key, generation]);

	return { resource, reload };
}
