import { useEffect, useState } from "react";
import { type DirEntry, type FileNode, fetchCopilotFileNode } from "./data";
import { Markdown } from "./Markdown";

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const extOf = (name: string) => {
	const i = name.lastIndexOf(".");
	return i === -1 ? "" : name.slice(i).toLowerCase();
};

// ── Directory tree (lazy — fetches a directory's children on first expand) ──
// Same visual pattern as FilesPanel.tsx's DirNode, simplified: read-only, no
// mission scoping (there's exactly one copilot workdir per user).

function DirNode({
	path,
	name,
	depth,
	selectedPath,
	onSelectFile,
}: {
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
		fetchCopilotFileNode(path).then(
			(n) => setEntries(n.type === "dir" ? n.entries : []),
			() => setEntries([]),
		);
	}, [open, entries, path]);

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
				) : entries.length === 0 ? (
					<p
						className="mut fn-loading"
						style={{ paddingLeft: 22 + depth * 14 }}
					>
						Empty.
					</p>
				) : (
					entries.map((e) =>
						e.type === "dir" ? (
							<DirNode
								key={e.name}
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

// ── Read-only content viewer ─────────────────────────────────────────────────

function FileViewer({ path }: { path: string }) {
	const [node, setNode] = useState<FileNode | null>(null);

	useEffect(() => {
		setNode(null);
		fetchCopilotFileNode(path).then(setNode, () => setNode(null));
	}, [path]);

	const name = path.split("/").pop() ?? path;
	const ext = extOf(name);

	return (
		<div className="fv">
			<div className="fv-head">
				<span className="fv-name">{name}</span>
			</div>
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
					<p className="mut">Binary file — no preview.</p>
				) : ext === ".md" || ext === ".markdown" ? (
					<Markdown text={node.content ?? ""} />
				) : (
					<>
						{node.truncated && <p className="mut">Truncated to 10 MB.</p>}
						<pre className="mv-json fv-pre">{node.content}</pre>
					</>
				)}
			</div>
		</div>
	);
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function CopilotFilesPanel() {
	const [selected, setSelected] = useState<string | null>(null);

	return (
		<div className="files">
			<div className="files-tree">
				<DirNode
					path=""
					name="workdir"
					depth={0}
					selectedPath={selected}
					onSelectFile={setSelected}
				/>
			</div>
			<div className="files-view">
				{selected ? (
					<FileViewer path={selected} />
				) : (
					<p className="mut">Select a file.</p>
				)}
			</div>
		</div>
	);
}
