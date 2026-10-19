import { api } from "./http";

export interface DirEntry {
	name: string;
	type: "dir" | "file";
	size?: number;
	modified?: string;
}

export type FileNode =
	| { type: "dir"; path: string; entries: DirEntry[] }
	| {
			type: "file";
			name: string;
			encoding: "text" | "base64" | "binary";
			mimeType?: string;
			content?: string;
			truncated?: boolean;
	  };

/** Browse a directory or read a file from the mission's shared workspace. */
export function fetchFileNode(
	missionId: string,
	path: string,
): Promise<FileNode> {
	return api<FileNode>(
		`/missions/${encodeURIComponent(missionId)}/files/shared?path=${encodeURIComponent(path)}`,
	);
}

export interface FileHistoryEntry {
	commit: string;
	timestamp: string;
	agentId: string | null;
	turnNumber: number | null;
}

/** Git provenance for a file — most recent commit first. */
export function fetchFileHistory(
	missionId: string,
	path: string,
): Promise<FileHistoryEntry[]> {
	return api<FileHistoryEntry[]>(
		`/missions/${encodeURIComponent(missionId)}/files/history?path=${encodeURIComponent(path)}`,
	);
}

/** Direct-download URL (file, or a folder as a zip) — for a plain <a href>. */
export function fileDownloadUrl(missionId: string, path: string): string {
	return `/missions/${encodeURIComponent(missionId)}/download?path=${encodeURIComponent(path)}`;
}

/**
 * Save an edited text file back to the mission's shared workspace. Commits
 * immediately and notifies the file's last-touching agent server-side (see
 * monitor-server.ts's handleFileEdit) — this call is fire-and-check, not a
 * two-step process. Only works while the mission is running (files live on
 * the Fly volume); the proxy returns 503 otherwise, surfaced here as a thrown
 * Error for the caller to display without losing the operator's edit.
 */
export async function saveFile(
	missionId: string,
	path: string,
	content: string,
	/** The file's last commit as loaded; the server refuses (409) when it has moved. Null = no check. */
	expectedHead: string | null = null,
): Promise<{ ok: boolean; commit: string | null }> {
	const res = await fetch(
		`/missions/${encodeURIComponent(missionId)}/files/shared/edit`,
		{
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path,
				content,
				...(expectedHead ? { expectedHead } : {}),
			}),
		},
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as {
			error?: string;
		} | null;
		throw new Error(body?.error ?? `HTTP ${res.status} saving ${path}`);
	}
	return (await res.json()) as { ok: boolean; commit: string | null };
}

// ── Trace panel (mission-wide cost + interaction overview) ─────────────────
