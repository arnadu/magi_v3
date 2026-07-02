import { useState } from "react";

/**
 * Recursive, lazily-expanding JSON tree — objects/arrays render as nested
 * <details>, long strings collapse to a preview. Children render only when
 * open, so a large value (e.g. a long message array) doesn't build a huge
 * hidden DOM tree. Shared by the Transcripts LLM-call drill-down and the
 * Files panel's JSON viewer.
 */
export function JsonNode({
	k,
	v,
	defaultOpen,
}: {
	k: string;
	v: unknown;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen ?? false);
	const isObj = v !== null && typeof v === "object";
	const longStr = typeof v === "string" && v.length > 120;

	if (!isObj && !longStr) {
		const text =
			v === null ? "null" : typeof v === "string" ? `"${v}"` : String(v);
		return (
			<div className="jn-leaf">
				<span className="jn-key">{k}</span>{" "}
				<span className="jn-val">{text}</span>
			</div>
		);
	}

	const entries: [string, unknown][] = isObj
		? Array.isArray(v)
			? (v as unknown[]).map((x, i) => [String(i), x])
			: Object.entries(v as Record<string, unknown>)
		: [];
	const preview = longStr
		? `"${(v as string).slice(0, 60)}…" (${(v as string).length} chars)`
		: Array.isArray(v)
			? `[${entries.length}]`
			: `{${entries.length}}`;

	return (
		<details
			className="jn"
			open={open}
			onToggle={(e) => setOpen(e.currentTarget.open)}
		>
			<summary>
				<span className="jn-key">{k}</span>{" "}
				<span className="jn-preview">{preview}</span>
			</summary>
			{open && (
				<div className="jn-children">
					{longStr ? (
						<pre className="mv-json">{v as string}</pre>
					) : (
						entries.map(([ck, cv]) => <JsonNode key={ck} k={ck} v={cv} />)
					)}
				</div>
			)}
		</details>
	);
}
