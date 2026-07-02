import { useEffect, useRef } from "react";
import { renderMarkdown } from "./markdown";

// Lazy, shared (module-level) loaders: mermaid and katex are both sizeable
// libraries (katex alone is ~260KB minified), so neither is in the main
// bundle — each is dynamically imported only once a placeholder for it
// actually shows up in the rendered DOM, and the promise is shared so
// concurrent <Markdown> instances (and mermaid.initialize(), which must run
// exactly once) don't duplicate the work.
let mermaidLoader: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
	if (!mermaidLoader) {
		mermaidLoader = import("mermaid").then((mod) => {
			mod.default.initialize({
				startOnLoad: false,
				// 'strict' runs mermaid's own DOMPurify-based sanitization on node
				// labels — the diagram source can come from agent-authored (and
				// transitively web-sourced) text, so treat it as untrusted.
				securityLevel: "strict",
				theme: "neutral",
			});
			return mod;
		});
	}
	return mermaidLoader;
}

let katexLoader: Promise<typeof import("katex")> | null = null;
function loadKatex() {
	if (!katexLoader) katexLoader = import("katex");
	return katexLoader;
}

let diagramSeq = 0;

/**
 * Renders markdown text as HTML. Shared by the Files viewer, the Conversations
 * rail, and the Transcripts message view — one renderer, one trust model
 * (renderMarkdown escapes first, then reintroduces a fixed tag whitelist).
 *
 * Mermaid diagrams and KaTeX math are a second pass: renderMarkdown emits
 * inert `[data-mermaid-src]` / `[data-katex-src]` placeholder divs (their
 * real rendering is async and/or a library too large to import eagerly);
 * this effect finds those placeholders after each render and fills them in
 * client-side, loading each library on demand.
 */
export function Markdown({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const html = renderMarkdown(text);

	// html isn't referenced in the body, but it's what produced ref.current's
	// DOM content (via dangerouslySetInnerHTML below) — this must re-run
	// whenever it changes to find and render any new placeholders.
	// biome-ignore lint/correctness/useExhaustiveDependencies: html drives ref.current's content indirectly, not referenced directly
	useEffect(() => {
		const container = ref.current;
		if (!container) return;
		let cancelled = false;

		const mermaidNodes =
			container.querySelectorAll<HTMLElement>("[data-mermaid-src]");
		if (mermaidNodes.length > 0) {
			loadMermaid().then(async ({ default: mermaid }) => {
				for (const node of mermaidNodes) {
					if (cancelled) return;
					const src = node.dataset.mermaidSrc ?? "";
					try {
						const id = `mermaid-${++diagramSeq}`;
						const { svg } = await mermaid.render(id, src);
						if (!cancelled) node.innerHTML = svg;
					} catch (e) {
						if (!cancelled) {
							node.textContent = `Diagram error: ${(e as Error).message}`;
						}
					}
				}
			});
		}

		const katexNodes =
			container.querySelectorAll<HTMLElement>("[data-katex-src]");
		if (katexNodes.length > 0) {
			loadKatex().then(({ default: katex }) => {
				for (const node of katexNodes) {
					if (cancelled) return;
					const src = node.dataset.katexSrc ?? "";
					try {
						katex.render(src, node, { throwOnError: false, displayMode: true });
					} catch (e) {
						node.textContent = `Math error: ${(e as Error).message}`;
					}
				}
			});
		}

		return () => {
			cancelled = true;
		};
	}, [html]);

	return (
		<div
			ref={ref}
			className={className ? `md ${className}` : "md"}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown HTML-escapes first, then reintroduces a fixed tag whitelist with scheme-checked links — see markdown.ts
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
