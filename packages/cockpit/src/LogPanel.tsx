import { useEffect, useRef, useState } from "react";
import { fetchDaemonLog } from "./data";

const LOG_LINES = 300;

/** Ported from index.html's log-viewer modal — the raw daemon.log tail, distinct from the Transcripts panel's LLM call history (this also catches crashes/orchestration errors outside any LLM call). */
export function LogPanel({ missionId }: { missionId: string | null }) {
	const [text, setText] = useState<string | "error" | null>(null);
	const [loading, setLoading] = useState(false);
	const preRef = useRef<HTMLPreElement | null>(null);

	async function load() {
		if (!missionId) return;
		setLoading(true);
		try {
			const t = await fetchDaemonLog(missionId, LOG_LINES);
			setText(t || "(log empty)");
		} catch {
			setText("error");
		} finally {
			setLoading(false);
			requestAnimationFrame(() => {
				const el = preRef.current;
				if (el) el.scrollTop = el.scrollHeight;
			});
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: load reads missionId via closure but is deliberately not itself a dependency (it's stable enough for a mount/mission-change effect)
	useEffect(() => {
		setText(null);
		void load();
	}, [missionId]);

	if (!missionId) {
		return <p className="mut">Select a live mission to see its log.</p>;
	}

	return (
		<div className="log-panel">
			<div className="log-panel-toolbar">
				<span className="mut">Last {LOG_LINES} lines of daemon.log</span>
				<button
					type="button"
					className="rail-btn"
					disabled={loading}
					onClick={load}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</button>
			</div>
			<pre className="log-content" ref={preRef}>
				{text === null
					? "Loading…"
					: text === "error"
						? "Could not load the log."
						: text}
			</pre>
		</div>
	);
}
