import { useCallback, useState } from "react";

/**
 * A failed fetch is a fact the operator needs, not an empty list. Panels
 * keep rendering whatever they have and show the failure next to it.
 */
export function useLoadError(): {
	loadError: string | null;
	failed: (what: string) => (e: unknown) => void;
	clearLoadError: () => void;
} {
	const [loadError, setLoadError] = useState<string | null>(null);
	const failed = useCallback(
		(what: string) => (e: unknown) =>
			setLoadError(`${what} failed: ${(e as Error).message}`),
		[],
	);
	const clearLoadError = useCallback(() => setLoadError(null), []);
	return { loadError, failed, clearLoadError };
}

export function LoadError({ message }: { message: string | null }) {
	if (!message) return null;
	return (
		<p className="error-msg" role="alert">
			{message}
		</p>
	);
}
