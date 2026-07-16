import { useEffect, useRef, useState } from "react";
import {
	type Agent,
	fetchAgents,
	fetchLlmCall,
	fetchLlmCalls,
	fetchTranscript,
	fetchTurns,
	type LlmCallDetail,
	type LlmCallSummary,
	type RawMessage,
	type TranscriptEntry,
	type TurnSummary,
} from "./data";
import { JsonNode } from "./JsonTree";
import { Markdown } from "./Markdown";

const fmtUsd = (n: number | undefined) => `$${(n ?? 0).toFixed(4)}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString();
const fmtTok = (n: number | undefined) =>
	n ? `${(n / 1000).toFixed(1)}k` : "0";

// ── Semantic message rendering (the transcript) ──────────────────────────────

function Block({ b }: { b: Record<string, unknown> }) {
	const t = b?.type as string | undefined;
	if (t === "text")
		return <Markdown text={String(b.text ?? "")} className="mv-text" />;
	if (t === "thinking" || t === "reasoning")
		return (
			<details className="mv-think">
				<summary>thinking</summary>
				<Markdown
					text={String(b.thinking ?? b.text ?? "")}
					className="mv-text"
				/>
			</details>
		);
	if (t === "toolCall")
		return (
			<div className="mv-tool">
				<span className="mv-toolname">🔧 {String(b.name ?? "tool")}</span>
				<details>
					<summary>args</summary>
					<pre className="mv-json">
						{JSON.stringify(b.arguments ?? b.input ?? {}, null, 2)}
					</pre>
				</details>
			</div>
		);
	if (t === "toolResult") {
		const c = b.content;
		return (
			<pre className="mv-json mv-result">
				{typeof c === "string" ? c : JSON.stringify(c, null, 2)}
			</pre>
		);
	}
	return <pre className="mv-json">{JSON.stringify(b, null, 2)}</pre>;
}

function Content({ content }: { content: unknown }) {
	if (content == null) return null;
	if (typeof content === "string")
		return <Markdown text={content} className="mv-text" />;
	if (Array.isArray(content))
		return (
			<>
				{content.map((b, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: content blocks are positional
					<Block key={i} b={b as Record<string, unknown>} />
				))}
			</>
		);
	return <pre className="mv-json">{JSON.stringify(content, null, 2)}</pre>;
}

function MessageView({ m, sub }: { m: RawMessage; sub?: boolean }) {
	const role = m.role;
	const label =
		role === "toolResult"
			? `↳ result${m.toolName ? ` · ${m.toolName}` : ""}${m.isError ? " ⚠" : ""}`
			: role;
	return (
		<div className={`mv mv-${role}${sub ? " mv-sub" : ""}`}>
			<span className="mv-role">{label}</span>
			<div className="mv-content">
				<Content content={m.content} />
			</div>
		</div>
	);
}

function toolCallsIn(m: RawMessage): { id: string; name: string }[] {
	if (!Array.isArray(m.content)) return [];
	return (m.content as Record<string, unknown>[])
		.filter((b) => b?.type === "toolCall")
		.map((b) => ({ id: String(b.id ?? ""), name: String(b.name ?? "tool") }));
}

// ── Turn timeline row ────────────────────────────────────────────────────────

function TurnRow({
	t,
	selected,
	onClick,
}: {
	t: TurnSummary;
	selected: boolean;
	onClick: () => void;
}) {
	const tools = Object.entries(t.toolCalls ?? {})
		.map(([k, v]) => `${k}·${v}`)
		.join(" ");
	const errs = Object.values(t.toolErrors ?? {}).reduce((a, b) => a + b, 0);
	return (
		<button
			type="button"
			className={`turn-row${selected ? " on" : ""}${t.status === "running" ? " live" : ""}`}
			onClick={onClick}
		>
			<div className="turn-hd">
				<span className="turn-n">#{t.turnNumber}</span>
				<span className={`turn-st st-${t.status}`}>{t.status}</span>
				<span className="turn-cost">{fmtUsd(t.costUsd)}</span>
			</div>
			<div className="turn-meta">
				{fmtTime(t.startedAt)} · {t.llmCallCount} calls ·{" "}
				{fmtTok(t.peakContextTokens)} peak
				{errs > 0 ? ` · ${errs} err` : ""}
			</div>
			{tools && <div className="turn-tools">{tools}</div>}
		</button>
	);
}

// ── Panel ────────────────────────────────────────────────────────────────────

type CallDetailState = LlmCallDetail | "loading" | null;

// Inline, collapsible LLM call under an assistant message: expands to Input and
// Output, each a nested JSON tree. Lazy-loads the full body on first open.
function LlmCallView({
	summary,
	detail,
	onOpen,
}: {
	summary: LlmCallSummary;
	detail: CallDetailState;
	onOpen: () => void;
}) {
	return (
		<details
			className="llmcall"
			onToggle={(e) => {
				if (e.currentTarget.open) onOpen();
			}}
		>
			<summary className="llmcall-sum">
				⚙ LLM call · {summary.model}
				{summary.isReflection ? " · refl" : ""} · {fmtTok(summary.usage?.input)}
				→{fmtTok(summary.usage?.output)} · {fmtUsd(summary.cost?.totalUsd)}
				{summary.costEstimated ? "~" : ""}
				{summary.stopReason ? ` · ${summary.stopReason}` : ""}
			</summary>
			<div className="llmcall-body">
				{detail === undefined || detail === "loading" ? (
					<p className="mut">Loading…</p>
				) : detail === null ? (
					<p className="mut">Failed to load.</p>
				) : (
					<>
						{detail.input ? (
							<JsonNode k="Input" v={detail.input} />
						) : (
							<p className="mut">Input not retained (past the 7-day window).</p>
						)}
						{detail.output ? (
							<JsonNode k="Output" v={detail.output.response} />
						) : (
							<p className="mut">
								Output not retained (past the 7-day window).
							</p>
						)}
					</>
				)}
			</div>
		</details>
	);
}

export interface TurnJump {
	agent: string;
	turn: number;
}

export function TranscriptsPanel({
	missionId,
	jumpTo,
	onJumped,
	runningAgents,
}: {
	missionId: string | null;
	/** A "inspect turn →" deep link from the Files panel's provenance header. */
	jumpTo?: TurnJump | null;
	onJumped?: () => void;
	/** Agent ids currently dispatched, live — for a busy indicator on chips. */
	runningAgents?: Set<string>;
}) {
	const [agents, setAgents] = useState<Agent[]>([]);
	const [agent, setAgent] = useState<string | null>(null);
	const [turns, setTurns] = useState<TurnSummary[]>([]);
	const [turn, setTurn] = useState<number | null>(null);
	const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
	const [calls, setCalls] = useState<LlmCallSummary[]>([]);
	const [detail, setDetail] = useState<Record<number, CallDetailState>>({});

	useEffect(() => {
		if (missionId) fetchAgents(missionId).then(setAgents, () => setAgents([]));
	}, [missionId]);

	useEffect(() => {
		if (missionId && agent)
			fetchTurns(missionId, agent).then(setTurns, () => setTurns([]));
		else setTurns([]);
		setTurn(null);
	}, [missionId, agent]);

	// Re-fetch the turn list the moment the selected agent finishes its
	// current turn (running → idle), instead of requiring a manual tab
	// switch to see the newly-completed turn appear.
	const wasRunningRef = useRef(false);
	useEffect(() => {
		const isRunning = !!agent && !!runningAgents?.has(agent);
		if (wasRunningRef.current && !isRunning && missionId && agent) {
			fetchTurns(missionId, agent).then(setTurns, () => {});
		}
		wasRunningRef.current = isRunning;
	}, [missionId, agent, runningAgents]);

	// Deep link from Files: jump straight to an agent + turn. Fetches its own
	// turn list and sets the turn directly (a harmless duplicate of the effect
	// above when the agent also changes — that effect's setTurn(null) always
	// fires synchronously first, so the turn set here always wins).
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires only when jumpTo changes
	useEffect(() => {
		if (!missionId || !jumpTo) return;
		setAgent(jumpTo.agent);
		fetchTurns(missionId, jumpTo.agent).then(
			(ts) => {
				setTurns(ts);
				setTurn(jumpTo.turn);
			},
			() => {},
		);
		onJumped?.();
	}, [jumpTo]);

	useEffect(() => {
		setDetail({});
		if (missionId && agent && turn != null) {
			fetchTranscript(missionId, agent, turn).then(setTranscript, () =>
				setTranscript([]),
			);
			fetchLlmCalls(missionId, agent, turn).then(setCalls, () => setCalls([]));
		} else {
			setTranscript([]);
			setCalls([]);
		}
	}, [missionId, agent, turn]);

	if (!missionId)
		return <p className="mut">Select a live mission to inspect its agents.</p>;

	const ensureDetail = (i: number) => {
		if (detail[i] !== undefined || !agent || turn == null) return;
		setDetail((d) => ({ ...d, [i]: "loading" }));
		fetchLlmCall(missionId, agent, turn, i).then(
			(full) => setDetail((d) => ({ ...d, [i]: full })),
			() => setDetail((d) => ({ ...d, [i]: null })),
		);
	};

	// Group Research sub-loop messages under their parent tool call.
	const subByParent = new Map<string, TranscriptEntry[]>();
	for (const e of transcript) {
		if (!e.parentToolUseId) continue;
		const arr = subByParent.get(e.parentToolUseId) ?? [];
		arr.push(e);
		subByParent.set(e.parentToolUseId, arr);
	}
	const topLevel = transcript.filter((e) => !e.parentToolUseId);

	// Each top-level assistant message IS the output of one LLM call. Map them
	// 1:1 in chronological order (both the transcript and llmCallLog are ordered),
	// so the k-th assistant message links to the k-th logged call.
	let asstSeq = -1;
	const callIndexFor = topLevel.map((e) =>
		e.message.role === "assistant" ? ++asstSeq : -1,
	);

	return (
		<div className="tx">
			<div className="tx-agents">
				<span className="kpilbl">Agent</span>
				{agents.map((a) => (
					<button
						type="button"
						key={a.id}
						className={`chip${agent === a.id ? " on" : ""}`}
						onClick={() => setAgent(a.id)}
					>
						{runningAgents?.has(a.id) && (
							<span className="busy-dot" title="Currently running" />
						)}
						{a.name}
					</button>
				))}
			</div>

			{!agent && <p className="mut">Pick an agent to see its turns.</p>}

			{agent && (
				<div className="tx-body">
					<div className="tx-turns">
						{turns.length === 0 && (
							<p className="mut rail-pad">No turns yet.</p>
						)}
						{turns.map((t) => (
							<TurnRow
								key={t.turnNumber}
								t={t}
								selected={turn === t.turnNumber}
								onClick={() => setTurn(t.turnNumber)}
							/>
						))}
					</div>

					<div className="tx-detail">
						{turn == null ? (
							<p className="mut">Pick a turn.</p>
						) : (
							<div className="transcript">
								{transcript.length === 0 && (
									<p className="mut">No messages in this turn.</p>
								)}
								{topLevel.map((e, idx) => {
									const tcs = toolCallsIn(e.message);
									const ci = callIndexFor[idx];
									return (
										// biome-ignore lint/suspicious/noArrayIndexKey: entries are positional
										<div key={idx} className="tx-entry">
											<MessageView m={e.message} />
											{ci >= 0 && ci < calls.length && (
												<LlmCallView
													summary={calls[ci]}
													detail={detail[ci]}
													onOpen={() => ensureDetail(ci)}
												/>
											)}
											{tcs.map((tc) => {
												const steps = subByParent.get(tc.id);
												if (!steps || steps.length === 0) return null;
												return (
													<details key={tc.id} className="subloop">
														<summary>
															🔬 {tc.name} sub-loop · {steps.length} steps
														</summary>
														<div className="subloop-body">
															{steps.map((se, i) => (
																<MessageView
																	// biome-ignore lint/suspicious/noArrayIndexKey: positional
																	key={i}
																	m={se.message}
																	sub
																/>
															))}
														</div>
													</details>
												);
											})}
										</div>
									);
								})}
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
