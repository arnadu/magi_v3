import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useState } from "react";
import {
	type DirEntry,
	type FileHistoryEntry,
	type FileNode,
	fetchFileHistory,
	fetchFileNode,
	fileDownloadUrl,
	saveFile,
} from "./data";
import { JsonNode } from "./JsonTree";
import { Markdown } from "./Markdown";
import { parseCsv } from "./markdown";

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const extOf = (name: string) => {
	const i = name.lastIndexOf(".");
	return i === -1 ? "" : name.slice(i).toLowerCase();
};
const MAX_CSV_ROWS = 500;

// ── Edit mode: one CodeMirror instance for every editable text type, syntax
// highlighting selected by extension where a mode exists, plain text (still
// line numbers + search) otherwise. Kept deliberately simple — no per-type
// custom editor (a JSON tree editor, a CSV grid) — matches read mode's own
// "type-driven rendering, not type-specific editing" scope.
const LANG_BY_EXT: Record<string, () => Extension> = {
	".json": () => json(),
	".yaml": () => yaml(),
	".yml": () => yaml(),
	".md": () => markdownLang(),
	".markdown": () => markdownLang(),
	".ts": () => javascript({ typescript: true }),
	".js": () => javascript(),
	".mjs": () => javascript(),
	".py": () => python(),
	".html": () => html(),
	".css": () => css(),
	".xml": () => xml(),
	".sql": () => sql(),
	".sh": () => StreamLanguage.define(shell),
	".bash": () => StreamLanguage.define(shell),
	".toml": () => StreamLanguage.define(toml),
};

function langFor(ext: string): Extension[] {
	const factory = LANG_BY_EXT[ext];
	return factory ? [factory()] : [];
}

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
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [htmlView, setHtmlView] = useState<"rendered" | "source">("rendered");

	useEffect(() => {
		setNode(null);
		setHistory(null);
		setEditing(false);
		setSaveError(null);
		setHtmlView("rendered");
		fetchFileNode(missionId, path).then(setNode, () => setNode(null));
		fetchFileHistory(missionId, path).then(setHistory, () => setHistory([]));
	}, [missionId, path]);

	const name = path.split("/").pop() ?? path;
	const ext = extOf(name);
	const editable =
		node?.type === "file" && node.encoding === "text" && !node.truncated;
	const isHtml = ext === ".html" || ext === ".htm";

	async function handleSave() {
		setSaving(true);
		setSaveError(null);
		try {
			await saveFile(missionId, path, draft);
			const [freshNode, freshHistory] = await Promise.all([
				fetchFileNode(missionId, path),
				fetchFileHistory(missionId, path),
			]);
			setNode(freshNode);
			setHistory(freshHistory);
			setEditing(false);
		} catch (e) {
			// Keep the operator's draft intact on failure (e.g. the mission was
			// suspended mid-edit) — never silently discard unsaved work.
			setSaveError((e as Error).message);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="fv">
			<div className="fv-head">
				<span className="fv-name">{name}</span>
				{editing ? (
					<>
						<button
							type="button"
							className="rail-btn"
							onClick={handleSave}
							disabled={saving}
						>
							{saving ? "Saving…" : "💾 Save"}
						</button>
						<button
							type="button"
							className="rail-btn"
							onClick={() => {
								setEditing(false);
								setSaveError(null);
							}}
							disabled={saving}
						>
							Cancel
						</button>
					</>
				) : (
					<>
						{isHtml && (
							<button
								type="button"
								className="rail-btn"
								onClick={() =>
									setHtmlView((v) => (v === "rendered" ? "source" : "rendered"))
								}
							>
								{htmlView === "rendered" ? "</> Source" : "👁 Preview"}
							</button>
						)}
						{editable && (
							<button
								type="button"
								className="rail-btn"
								onClick={() => {
									setDraft(node?.type === "file" ? (node.content ?? "") : "");
									setEditing(true);
								}}
							>
								✎ Edit
							</button>
						)}
						<a
							className="rail-btn"
							href={fileDownloadUrl(missionId, path)}
							target="_blank"
							rel="noopener noreferrer"
						>
							⬇ Download
						</a>
					</>
				)}
			</div>
			{saveError && <p className="fv-error">{saveError}</p>}
			{!editing && (
				<Provenance history={history} onInspectTurn={onInspectTurn} />
			)}
			<div className="fv-body">
				{editing ? (
					<CodeMirror
						value={draft}
						extensions={langFor(ext)}
						onChange={setDraft}
						height="70vh"
					/>
				) : node === null ? (
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
				) : isHtml && htmlView === "rendered" ? (
					<iframe
						className="fv-html-frame"
						title={name}
						srcDoc={node.content ?? ""}
						// No allow-same-origin: the frame gets an opaque origin, so
						// agent-authored (possibly web-influenced, per TB-8) HTML/JS
						// cannot read the magi_session cookie, call the control-plane
						// API with the operator's credentials, or reach the parent
						// DOM — the same trust boundary already applied to mental-map
						// HTML elsewhere in the cockpit, just via sandboxing instead of
						// stripping tags, since this feature needs live script to run.
						sandbox="allow-scripts"
					/>
				) : ext === ".md" || ext === ".markdown" ? (
					<Markdown text={node.content ?? ""} />
				) : ext === ".csv" ? (
					<CsvTable text={node.content ?? ""} />
				) : ext === ".json" && !node.truncated ? (
					<JsonTry text={node.content ?? ""} name={name} />
				) : (
					<>
						{node.truncated && (
							<p className="mut">
								Truncated to 10 MB —{" "}
								<a
									href={fileDownloadUrl(missionId, path)}
									target="_blank"
									rel="noopener noreferrer"
								>
									download the full file
								</a>
								. Truncated files can't be edited from the cockpit.
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
