import { renderMarkdown } from "./markdown";

/**
 * Renders markdown text as HTML. Shared by the Files viewer, the Conversations
 * rail, and the Transcripts message view — one renderer, one trust model
 * (renderMarkdown escapes first, then reintroduces a fixed tag whitelist).
 */
export function Markdown({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	return (
		<div
			className={className ? `md ${className}` : "md"}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: renderMarkdown HTML-escapes first, then reintroduces a fixed tag whitelist with scheme-checked links — see markdown.ts
			dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
		/>
	);
}
