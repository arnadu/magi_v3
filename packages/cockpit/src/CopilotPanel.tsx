import { useEffect, useRef, useState } from "react";
import {
	type CopilotSettings,
	confirmCopilotAction,
	dismissCopilotAction,
	fetchCopilotHistory,
	fetchCopilotSettings,
	fetchCopilotUsage,
	type RawMessage,
	saveCopilotSettings,
	sendCopilotMessage,
} from "./data";

/**
 * Ports index.html's #copilot-panel (lines ~339-360, ~1342-1607) to the
 * cockpit — same SSE event set (copilot-msg/action/action-result/error/
 * usage/loop-msg), same message-list model, same model-picker flow.
 */

let nextEntryId = 0;

// Each kind gets its own union member (rather than bundling "user" |
// "copilot" | "system" under one shape) — TypeScript's control-flow
// narrowing for a literal discriminant is reliable per-member but not
// guaranteed for an `||` check against sub-values sharing one member.
type Entry =
	| { id: number; kind: "user"; text: string }
	| { id: number; kind: "copilot"; text: string }
	| { id: number; kind: "system"; text: string }
	| { id: number; kind: "activity"; text: string; isError: boolean }
	| {
			id: number;
			kind: "action";
			actionId: string;
			type: string;
			label: string;
			resolved?: { ok: boolean; text: string };
	  };

function fmtTokens(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k tok` : `${n} tok`;
}

/** Most informative single-line summary of a tool call's arguments — mirrors index.html's formatToolArgs. */
function formatToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const val =
		a.command ??
		a.query ??
		a.task ??
		a.missionId ??
		a.id ??
		a.path ??
		a.label ??
		a.url ??
		null;
	if (val == null) return "";
	const s = String(val);
	return s.length > 70 ? `${s.slice(0, 70)}…` : s;
}

const WIDTH_STORAGE_KEY = "magi-copilot-panel-width";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

function loadStoredWidth(): number {
	const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
	const n = raw ? Number(raw) : Number.NaN;
	return Number.isFinite(n)
		? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n))
		: DEFAULT_WIDTH;
}

export function CopilotPanel() {
	const [width, setWidth] = useState(loadStoredWidth);

	// Matches ConversationsPanel's startResize (same closure-over-`last`
	// pattern, direct position rather than delta tracking — no stale-closure
	// risk either way). The rail derives width straight from clientX because
	// it's pinned to the viewport's left edge; this panel is pinned to the
	// right edge instead, so width is the distance from clientX to the right
	// edge of the viewport.
	const startResize = (e: React.MouseEvent) => {
		e.preventDefault();
		let last = width;
		const onMove = (ev: MouseEvent) => {
			last = Math.min(
				MAX_WIDTH,
				Math.max(MIN_WIDTH, window.innerWidth - ev.clientX),
			);
			setWidth(last);
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			localStorage.setItem(WIDTH_STORAGE_KEY, String(last));
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	const [entries, setEntries] = useState<Entry[]>([]);
	const [thinking, setThinking] = useState(false);
	const [usage, setUsage] = useState<{
		calls: number;
		inputTokens: number;
		costUsd: number;
	} | null>(null);
	const [settings, setSettings] = useState<CopilotSettings | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [modelInput, setModelInput] = useState("");
	const [modelError, setModelError] = useState<string | null>(null);
	const [input, setInput] = useState("");
	const messagesRef = useRef<HTMLDivElement | null>(null);

	// Omit<Entry, "id"> doesn't distribute over the union (keyof a union is the
	// intersection of member keys, collapsing this to just {kind}) — the
	// `T extends unknown ? ... : never` trick forces per-member distribution.
	function push<T extends Entry>(
		entry: T extends unknown ? Omit<T, "id"> : never,
	) {
		setEntries((prev) => [...prev, { ...entry, id: nextEntryId++ } as Entry]);
	}

	function scrollBottom() {
		requestAnimationFrame(() => {
			const el = messagesRef.current;
			if (el) el.scrollTop = el.scrollHeight;
		});
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: connect-once-on-mount, matching useMissionStatus's connect() effect — push/scrollBottom are stable helpers, not reactive values
	useEffect(() => {
		let cancelled = false;

		(async () => {
			const [history, u, s] = await Promise.all([
				fetchCopilotHistory().catch(() => []),
				fetchCopilotUsage().catch(() => null),
				fetchCopilotSettings().catch(() => null),
			]);
			if (cancelled) return;
			if (history.length > 0) {
				setEntries(
					history.map((h) => ({
						id: nextEntryId++,
						kind: h.role === "user" ? "user" : "copilot",
						text: h.body,
					})),
				);
				push({ kind: "system", text: "─── earlier messages above ───" });
			}
			if (u) setUsage(u);
			if (s) setSettings(s);
			scrollBottom();
		})();

		const es = new EventSource("/api/copilot/events", {
			withCredentials: true,
		});

		es.addEventListener("copilot-msg", (e) => {
			const msg = JSON.parse((e as MessageEvent).data) as { body?: string };
			push({ kind: "copilot", text: msg.body ?? "" });
			setThinking(false);
			scrollBottom();
		});

		es.addEventListener("copilot-action", (e) => {
			const action = JSON.parse((e as MessageEvent).data) as {
				id: string;
				type: string;
				label: string;
			};
			push({
				kind: "action",
				actionId: action.id,
				type: action.type,
				label: action.label,
			});
			setThinking(false);
			scrollBottom();
		});

		es.addEventListener("copilot-action-result", (e) => {
			const result = JSON.parse((e as MessageEvent).data) as {
				id: string;
				ok: boolean;
				result?: string;
				error?: string;
			};
			setEntries((prev) =>
				prev.map((entry) =>
					entry.kind === "action" && entry.actionId === result.id
						? {
								...entry,
								resolved: {
									ok: result.ok,
									text: result.ok
										? (result.result ?? "")
										: (result.error ?? ""),
								},
							}
						: entry,
				),
			);
			scrollBottom();
		});

		es.addEventListener("copilot-error", (e) => {
			const { errorMessage } = JSON.parse((e as MessageEvent).data) as {
				errorMessage?: string;
			};
			push({
				kind: "activity",
				text: `⚠ Error: ${errorMessage}`,
				isError: true,
			});
			setThinking(false);
			scrollBottom();
		});

		es.addEventListener("copilot-usage", (e) => {
			setUsage(
				JSON.parse((e as MessageEvent).data) as {
					calls: number;
					inputTokens: number;
					costUsd: number;
				},
			);
		});

		es.addEventListener("copilot-loop-msg", (e) => {
			const msg = JSON.parse((e as MessageEvent).data) as RawMessage;
			setThinking(true);
			if (msg.role === "assistant") {
				if (msg.stopReason === "error") {
					push({
						kind: "activity",
						text: `⚠ LLM error: ${(msg.errorMessage as string) || "(no details)"}`,
						isError: true,
					});
					setThinking(false);
					scrollBottom();
					return;
				}
				const blocks = (msg.content as Array<Record<string, unknown>>) ?? [];
				for (const block of blocks) {
					if (block.type === "toolCall") {
						const arg = formatToolArgs(block.arguments);
						push({
							kind: "activity",
							text: arg ? `▶ ${block.name}: ${arg}` : `▶ ${block.name}`,
							isError: false,
						});
					}
				}
			} else if (msg.role === "toolResult") {
				if (msg.toolName === "PostMessage") return;
				const blocks = (msg.content as Array<Record<string, unknown>>) ?? [];
				const text = blocks
					.filter((b) => b.type === "text")
					.map((b) => b.text as string)
					.join("\n");
				const preview = text.length > 150 ? `${text.slice(0, 150)}…` : text;
				push({
					kind: "activity",
					text: `← ${msg.toolName}: ${preview}`,
					isError: !!msg.isError,
				});
			}
			scrollBottom();
		});

		es.onerror = () => setThinking(false);

		return () => {
			cancelled = true;
			es.close();
		};
	}, []);

	async function handleSend() {
		const text = input.trim();
		if (!text) return;
		setInput("");
		push({ kind: "user", text });
		setThinking(true);
		scrollBottom();
		try {
			await sendCopilotMessage(text);
		} catch {
			setThinking(false);
			push({ kind: "system", text: "Failed to send message." });
		}
	}

	async function handleConfirm(actionId: string) {
		const { result, error } = await confirmCopilotAction(actionId);
		setEntries((prev) =>
			prev.map((entry) =>
				entry.kind === "action" && entry.actionId === actionId
					? { ...entry, resolved: { ok: !error, text: error ?? result ?? "" } }
					: entry,
			),
		);
	}

	async function handleDismiss(actionId: string) {
		await dismissCopilotAction(actionId);
		setEntries((prev) =>
			prev.map((entry) =>
				entry.kind === "action" && entry.actionId === actionId
					? { ...entry, resolved: { ok: true, text: "dismissed" } }
					: entry,
			),
		);
	}

	async function handleSaveModel() {
		setModelError(null);
		try {
			await saveCopilotSettings(modelInput.trim() || null);
			const s = await fetchCopilotSettings();
			setSettings(s);
			setPickerOpen(false);
		} catch (e) {
			setModelError((e as Error).message);
		}
	}

	return (
		<div className="copilot-panel" style={{ width }}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-to-resize handle, matches ConversationsPanel's rail-resize */}
			<div
				className="copilot-resize"
				onMouseDown={startResize}
				title="Drag to resize"
			/>
			<div className="copilot-header">
				<h3>MAGI Copilot</h3>
				<div className="copilot-header-right">
					{usage && usage.calls > 0 && (
						<span className="mut copilot-cost">
							{usage.calls} calls · {fmtTokens(usage.inputTokens)} · $
							{usage.costUsd.toFixed(4)}
						</span>
					)}
					<button
						type="button"
						className="rail-btn copilot-model-btn"
						title="Change the copilot's model"
						onClick={() => {
							setModelInput(
								settings && !settings.isDefault ? settings.model : "",
							);
							setPickerOpen((v) => !v);
						}}
					>
						{settings
							? settings.isDefault
								? `model: ${settings.model} (default)`
								: `model: ${settings.model}`
							: "model"}
					</button>
				</div>
			</div>
			{pickerOpen && (
				<div className="copilot-model-picker">
					<label htmlFor="copilot-model-input">
						Copilot model — leave blank for the deployment default
					</label>
					<input
						id="copilot-model-input"
						value={modelInput}
						onChange={(e) => setModelInput(e.target.value)}
						placeholder="e.g. claude-opus-4-8"
					/>
					<button
						type="button"
						className="btn-primary"
						onClick={handleSaveModel}
					>
						Save
					</button>
					<button
						type="button"
						className="rail-btn"
						onClick={() => setPickerOpen(false)}
					>
						Cancel
					</button>
					{modelError && (
						<p className="error-msg copilot-model-error">{modelError}</p>
					)}
				</div>
			)}
			<div className="copilot-messages" ref={messagesRef}>
				{entries.length === 0 && (
					<div className="cop-bubble system-msg">
						Copilot is ready. Ask a question or describe a task.
					</div>
				)}
				{entries.map((entry) => {
					if (entry.kind === "user" || entry.kind === "copilot") {
						return (
							<div
								key={entry.id}
								className={`cop-bubble from-${entry.kind === "user" ? "user" : "copilot"}`}
							>
								{entry.text}
							</div>
						);
					}
					if (entry.kind === "system") {
						return (
							<div key={entry.id} className="cop-bubble system-msg">
								{entry.text}
							</div>
						);
					}
					if (entry.kind === "activity") {
						return (
							<div
								key={entry.id}
								className={`cop-activity${entry.isError ? " tool-error" : ""}`}
							>
								{entry.text}
							</div>
						);
					}
					return (
						<div key={entry.id} className="cop-action-card">
							<div className="action-label">{entry.label}</div>
							<div className="action-type">type: {entry.type}</div>
							{entry.resolved ? (
								<div
									className={`action-result${entry.resolved.ok ? "" : " error"}`}
								>
									{entry.resolved.ok ? "✓ " : "✗ "}
									{entry.resolved.text}
								</div>
							) : (
								<div className="action-btns">
									<button
										type="button"
										className="btn-primary btn-sm"
										onClick={() => handleConfirm(entry.actionId)}
									>
										Confirm
									</button>
									<button
										type="button"
										className="rail-btn btn-sm"
										onClick={() => handleDismiss(entry.actionId)}
									>
										Dismiss
									</button>
								</div>
							)}
						</div>
					);
				})}
			</div>
			{thinking && <div className="copilot-thinking">Copilot is thinking…</div>}
			<div className="copilot-input-area">
				<textarea
					rows={1}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void handleSend();
						}
					}}
					placeholder="Message the copilot…"
				/>
				<button type="button" className="btn-primary" onClick={handleSend}>
					Send
				</button>
			</div>
		</div>
	);
}
