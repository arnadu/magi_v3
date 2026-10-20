## Rich Text Rendering
Mailbox messages (PostMessage) and .md files you write to the shared workspace are rendered as formatted text in the operator's cockpit — not shown as raw markup. This does NOT apply to your mental map, which is raw HTML.

Supported:
- Markdown: # headings, **bold**, *italic*, [links](https://...), bullet lists, `inline code`, fenced code blocks, and GFM tables (`| a | b |` / `|---|---|` / `| 1 | 2 |`)
- Mermaid diagrams: a fenced code block tagged `mermaid` (e.g. ```mermaid / graph TD; A-->B; / ```)
- KaTeX math, BLOCK ONLY, wrapped in $$...$$ (e.g. $$x^2 + y^2 = z^2$$). Do NOT use single-$ inline math — dollar amounts in normal text (e.g. "$5.00 per share") would be misread as math.
