import { useEffect, useState } from "react";
import {
	type FileHistoryEntry,
	type FileNode,
	fetchFileHistory,
	fetchFileNode,
} from "./data";

/**
 * Load one shared file and its git history for the viewer. Cancels a late
 * response for the previous path: without the guard, file A's content could
 * be shown under file B's name and then saved there (FP1). A failed load is
 * reported, not left as "Loading…" forever.
 */
export function useFileNode(
	missionId: string,
	path: string,
): {
	node: FileNode | null;
	setNode: (n: FileNode | null) => void;
	history: FileHistoryEntry[] | null;
	setHistory: (h: FileHistoryEntry[] | null) => void;
	loadError: string | null;
} {
	const [node, setNode] = useState<FileNode | null>(null);
	const [history, setHistory] = useState<FileHistoryEntry[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setNode(null);
		setHistory(null);
		setLoadError(null);
		fetchFileNode(missionId, path).then(
			(n) => {
				if (!cancelled) setNode(n);
			},
			(e) => {
				if (!cancelled) setLoadError(`Loading failed: ${(e as Error).message}`);
			},
		);
		fetchFileHistory(missionId, path).then(
			(h) => {
				if (!cancelled) setHistory(h);
			},
			() => {
				if (!cancelled) setHistory([]);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [missionId, path]);

	return { node, setNode, history, setHistory, loadError };
}
