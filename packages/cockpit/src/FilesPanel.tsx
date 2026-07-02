import { useEffect, useState } from "react";
import {
	type DirEntry,
	type FileHistoryEntry,
	type FileNode,
	fetchFileHistory,
	fetchFileNode,
	fileDownloadUrl,
} from "./data";
import { JsonNode } from "./JsonTree";
import { parseCsv, renderMarkdown } from "./markdown";

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const extOf = (name: string) => {
	const i = name.lastIndexOf(".");
	return i === -1 ? "" : name.slice(i).toLowerCase();
};
const MAX_CSV_ROWS = 500;

function fmtTime(iso: string) {
	return new Date(iso).toLocaleString();
}

// ── Directory tree (lazy — fetches a directory's children on first expand) ──

function DirNode({
	missionId,
	path,
	name,
	depth,
	selectedPath,
	onSelectFile,
}: {
	missionId: string;
	path: string;
	name: string;
	depth: number;
	selectedPath: string | null;
	onSelectFile: (path: string) => void;
}) {
	const [open, setOpen] = useState(depth === 0);
	const [entries, setEntries] = useState<DirEntry[] | null>(null);

	useEffect(() => {
		if (!open || entries !== null) return;
		fetchFileNode(missionId, path).then(
			(n) => setEntries(n.type === "dir" ? n.entries : []),
			() => setEntries([]),
		);
	}, [open, entries, missionId, path]);

	return (
		<div>
			<button
				type="button"
				className="fn-row fn-dir"
				style={{ paddingLeft: 8 + depth * 14 }}
				onClick={() => setOpen((o) => !o)}
			>
				<span className={`caret ${open ? "" : "closed"}`}>▾</span>📁 {name}
			</button>
			{open &&
				(entries === null ? (
					<p
						className="mut fn-loading"
						style={{ paddingLeft: 22 + depth * 14 }}
					>
						Loading…
					</p>
				) : (
					entries.map((e) =>
						e.type === "dir" ? (
							<DirNode
								key={e.name}
								missionId={missionId}
								path={joinPath(path, e.name)}
								name={e.name}
								depth={depth + 1}
								selectedPath={selectedPath}
								onSelectFile={onSelectFile}
							/>
						) : (
							<button
								type="button"
								key={e.name}
								className={`fn-row fn-file${selectedPath === joinPath(path, e.name) ? " on" : ""}`}
								style={{ paddingLeft: 22 + depth * 14 }}
								onClick={() => onSelectFile(joinPath(path, e.name))}
							>
								📄 {e.name}
							</button>
						),
					)
				))}
		</div>
	);
}

// ── Provenance header ────────────────────────────────────────────────────────

function Provenance({
	history,
	onInspectTurn,
}: {
	history: FileHistoryEntry[] | null;
	onInspectTurn?: (agentId: string, turn: number) => void;
}) {
	if (history === null) return <p className="mut">Loading history…</p>;
	if (history.length === 0)
		return <p className="mut">No git history for this file.</p>;
	const [latest, ...rest] = history;
	return (
		<div className="provenance">
			<div className="prov-latest">
				{latest.agentId != null && latest.turnNumber != null ? (
					<>
						<span className="mut">Last updated by</span> <b>{latest.agentId}</b>{" "}
						<span className="mut">· turn</span> <b>{latest.turnNumber}</b>
						{onInspectTurn && (
							<button
								type="button"
								className="rail-btn prov-inspect"
								onClick={() =>
									onInspectTurn(
										latest.agentId as string,
										latest.turnNumber as number,
									)
								}
							>
								inspect turn →
							</button>
						)}
					</>
				) : (
					<span className="mut">
						Last commit {latest.commit.slice(0, 7)} ·{" "}
						{fmtTime(latest.timestamp)} (no turn record — provisioning or an
						outside edit)
					</span>
				)}
			</div>
			{rest.length > 0 && (
				<details className="prov-history">
					<summary>
						{rest.length} earlier change{rest.length === 1 ? "" : "s"}
					</summary>
					<ul>
						{rest.map((h) => (
							<li key={h.commit}>
								{h.agentId != null && h.turnNumber != null ? (
									<button
										type="button"
										className="prov-hist-link"
										onClick={() =>
											onInspectTurn?.(
												h.agentId as string,
												h.turnNumber as number,
											)
										}
									>
										{h.agentId} · turn {h.turnNumber}
									</button>
								) : (
									<span className="mut">{h.commit.slice(0, 7)}</span>
								)}{" "}
								<span className="mut">{fmtTime(h.timestamp)}</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}

// ── Type-driven content viewer ───────────────────────────────────────────────

function FileViewer({
	missionId,
	path,
	onInspectTurn,
}: {
	missionId: string;
	path: string;
	onInspectTurn: (agentId: string, turn: number) => void;
}) {
	const [node, setNode] = useState<FileNode | null>(null);
	const [history, setHistory] = useState<FileHistoryEntry[] | null>(null);

	useEffect(() => {
		setNode(null);
		setHistory(null);
		fetchFileNode(missionId, path).then(setNode, () => setNode(null));
		fetchFileHistory(missionId, path).then(setHistory, () => setHistory([]));
	}, [missionId, path]);

	const name = path.split("/").pop() ?? path;
	const ext = extOf(name);

	return (
		<div className="fv">
			<div className="fv-head">
				<span className="fv-name">{name}</span>
				<a
					className="rail-btn"
					href={fileDownloadUrl(missionId, path)}
					target="_blank"
					rel="noopener noreferrer"
				>
					⬇ Download
				</a>
			</div>
			<Provenance history={history} onInspectTurn={onInspectTurn} />
			<div className="fv-body">
				{node === null ? (
					<p className="mut">Loading…</p>
				) : node.type === "dir" ? (
					<p className="mut">Not a file.</p>
				) : node.encoding === "base64" ? (
					<img
						className="fv-image"
						src={`data:${node.mimeType};base64,${node.content}`}
						alt={name}
					/>
				) : node.encoding === "binary" ? (
					<p className="mut">
						Binary file — no preview.{" "}
						<a
							href={fileDownloadUrl(missionId, path)}
							target="_blank"
							rel="noopener noreferrer"
						>
							Download
						</a>{" "}
						to view.
					</p>
				) : ext === ".md" || ext === ".markdown" ? (
					<div
						className="fv-markdown"
						// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown HTML-escapes first, then reintroduces a fixed tag whitelist — see markdown.ts
						dangerouslySetInnerHTML={{
							__html: renderMarkdown(node.content ?? ""),
						}}
					/>
				) : ext === ".csv" ? (
					<CsvTable text={node.content ?? ""} />
				) : ext === ".json" && !node.truncated ? (
					<JsonTry text={node.content ?? ""} name={name} />
				) : (
					<>
						{node.truncated && (
							<p className="mut">
								Truncated to 200 KB —{" "}
								<a
									href={fileDownloadUrl(missionId, path)}
									target="_blank"
									rel="noopener noreferrer"
								>
									download the full file
								</a>
								.
							</p>
						)}
						<pre className="mv-json fv-pre">{node.content}</pre>
					</>
				)}
			</div>
		</div>
	);
}

function JsonTry({ text, name }: { text: string; name: string }) {
	try {
		const parsed = JSON.parse(text);
		return <JsonNode k={name} v={parsed} defaultOpen />;
	} catch {
		return <pre className="mv-json fv-pre">{text}</pre>;
	}
}

function CsvTable({ text }: { text: string }) {
	const rows = parseCsv(text);
	if (rows.length === 0) return <p className="mut">Empty file.</p>;
	const [header, ...body] = rows;
	const shown = body.slice(0, MAX_CSV_ROWS);
	return (
		<>
			{body.length > MAX_CSV_ROWS && (
				<p className="mut">
					Showing {MAX_CSV_ROWS} of {body.length} rows — download for full data.
				</p>
			)}
			<div className="csv-wrap">
				<table className="csv-table">
					<thead>
						<tr>
							{header.map((h, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: header cells are positional
								<th key={i}>{h}</th>
							))}
						</tr>
					</thead>
					<tbody>
						{shown.map((r, ri) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
							<tr key={ri}>
								{r.map((c, ci) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
									<td key={ci}>{c}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function FilesPanel({
	missionId,
	onInspectTurn,
}: {
	missionId: string | null;
	onInspectTurn: (agentId: string, turn: number) => void;
}) {
	const [selected, setSelected] = useState<string | null>(null);

	if (!missionId)
		return <p className="mut">Select a live mission to browse its files.</p>;

	return (
		<div className="files">
			<div className="files-tree">
				<DirNode
					missionId={missionId}
					path=""
					name="shared"
					depth={0}
					selectedPath={selected}
					onSelectFile={setSelected}
				/>
			</div>
			<div className="files-view">
				{selected ? (
					<FileViewer
						missionId={missionId}
						path={selected}
						onInspectTurn={onInspectTurn}
					/>
				) : (
					<p className="mut">Select a file.</p>
				)}
			</div>
		</div>
	);
}
