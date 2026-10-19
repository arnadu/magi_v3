import { html as htmlLang } from "@codemirror/lang-html";
import CodeMirror from "@uiw/react-codemirror";
import { useRef, useState } from "react";

/**
 * Mental map viewer/editor — syntax-highlighted HTML source by default (never
 * executed, safe regardless of content), with an opt-in "Preview" toggle that
 * renders it in a sandboxed iframe. Same trust boundary FilesPanel's `.html`
 * viewer already uses for agent-authored (possibly web-influenced, TB-8)
 * HTML: no `allow-same-origin` on the sandbox, so even literal `<script>`
 * content can't read cookies or call the API with the operator's session.
 * `key={agentId}` at the call site remounts this fresh per agent, so the
 * view always resets to source when switching tabs.
 */
export function MentalMapEditor({
	html,
	onChange,
	editable,
}: {
	html: string;
	onChange: (html: string) => void;
	editable: boolean;
}) {
	const [view, setView] = useState<"source" | "rendered">("source");
	// Applied imperatively on the DOM node, not via a React style prop — the
	// native resize handle (below) also sets this element's inline height
	// directly on drag, and a React-controlled style prop would fight it,
	// snapping back to whatever this component last rendered on the very next
	// keystroke's re-render.
	const [expanded, setExpanded] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);

	function toggleExpanded() {
		const next = !expanded;
		setExpanded(next);
		if (wrapperRef.current) {
			wrapperRef.current.style.height = next ? "600px" : "220px";
		}
	}

	return (
		<div className="config-mentalmap">
			<div className="config-mentalmap-toolbar">
				<button type="button" className="rail-btn" onClick={toggleExpanded}>
					{expanded ? "⤡ Collapse" : "⤢ Expand"}
				</button>
				<button
					type="button"
					className="rail-btn"
					onClick={() =>
						setView((v) => (v === "rendered" ? "source" : "rendered"))
					}
				>
					{view === "rendered" ? "</> Source" : "👁 Preview"}
				</button>
			</div>
			<div className="config-mentalmap-resizable" ref={wrapperRef}>
				{view === "rendered" ? (
					<iframe
						className="config-mentalmap-frame"
						title="Mental map preview"
						srcDoc={html}
						sandbox="allow-scripts"
					/>
				) : (
					<CodeMirror
						value={html}
						extensions={[htmlLang()]}
						readOnly={!editable}
						onChange={onChange}
						height="100%"
					/>
				)}
			</div>
		</div>
	);
}
