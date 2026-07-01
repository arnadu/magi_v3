import { useEffect, useState } from "react";
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

const fmtUsd = (n: number | undefined) => `$${(n ?? 0).toFixed(4)}`;
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString();
const fmtTok = (n: number | undefined) =>
	n ? `${(n / 1000).toFixed(1)}k` : "0";

// ── Message rendering (shared by transcript + LLM-call drill-down) ───────────

function Block({ b }: { b: Record<string, unknown> }) {
	const t = b?.type as string | undefined;
	if (t === "text")
		return <div className="mv-text">{String(b.text ?? "")}</div>;
	if (t === "thinking" || t === "reasoning")
		return (
			<details className="mv-think">
				<summary>thinking</summary>
				<div className="mv-text">{String(b.thinking ?? b.text ?? "")}</div>
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
		return <div className="mv-text">{content}</div>;
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

// ── LLM-call drill-down ──────────────────────────────────────────────────────

function LlmCallDetailView({ c }: { c: LlmCallDetail }) {
	return (
		<div className="call-detail">
			<div className="call-hd">
				<b>{c.model}</b>
				{c.isReflection && <span className="tag">reflection</span>}
				<span className="mut">{fmtTime(c.savedAt)}</span>
				<span className="mut">
					in {fmtTok(c.usage?.input)} · out {fmtTok(c.usage?.output)} · cache{" "}
					{fmtTok(c.usage?.cacheRead)}
				</span>
				<span className="call-cost">
					{fmtUsd(c.cost?.totalUsd)}
					{c.costEstimated ? "~" : ""}
				</span>
			</div>
			{c.input ? (
				<>
					<details className="call-sect" open>
						<summary>System prompt</summary>
						<pre className="mv-json sysprompt">{c.input.systemPrompt}</pre>
					</details>
					<details className="call-sect">
						<summary>
							Input — {c.input.messages.length} messages · tools:{" "}
							{c.input.toolNames.join(", ") || "none"}
						</summary>
						<div className="call-msgs">
							{c.input.messages.map((m, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: messages are positional
								<MessageView key={i} m={m} />
							))}
						</div>
					</details>
				</>
			) : (
				<p className="mut">Input not retained (past the 7-day window).</p>
			)}
			<div className="call-sect-open">
				<div className="call-sect-title">Output</div>
				{c.output ? (
					<MessageView m={c.output.response} />
				) : (
					<p className="mut">Output not retained (past the 7-day window).</p>
				)}
			</div>
		</div>
	);
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function TranscriptsPanel({ missionId }: { missionId: string | null }) {
	const [agents, setAgents] = useState<Agent[]>([]);
	const [agent, setAgent] = useState<string | null>(null);
	const [turns, setTurns] = useState<TurnSummary[]>([]);
	const [turn, setTurn] = useState<number | null>(null);
	const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
	const [calls, setCalls] = useState<LlmCallSummary[]>([]);
	const [openCall, setOpenCall] = useState<LlmCallDetail | null>(null);
	const [tab, setTab] = useState<"conversation" | "llm">("conversation");

	useEffect(() => {
		if (missionId) fetchAgents(missionId).then(setAgents, () => setAgents([]));
	}, [missionId]);

	useEffect(() => {
		if (missionId && agent)
			fetchTurns(missionId, agent).then(setTurns, () => setTurns([]));
		else setTurns([]);
		setTurn(null);
	}, [missionId, agent]);

	useEffect(() => {
		setOpenCall(null);
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

	const openCallDetail = (i: number) => {
		if (missionId && agent && turn != null)
			fetchLlmCall(missionId, agent, turn, i).then(setOpenCall, () => {});
	};

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
							<>
								<nav className="tx-subtabs">
									<button
										type="button"
										className={`tab ${tab === "conversation" ? "on" : ""}`}
										onClick={() => setTab("conversation")}
									>
										Conversation
									</button>
									<button
										type="button"
										className={`tab ${tab === "llm" ? "on" : ""}`}
										onClick={() => setTab("llm")}
									>
										LLM calls ({calls.length})
									</button>
								</nav>

								{tab === "conversation" ? (
									<div className="transcript">
										{transcript.length === 0 && (
											<p className="mut">No messages in this turn.</p>
										)}
										{transcript.map((e) => (
											<MessageView
												key={`${e.callSeq}-${e.parentToolUseId ?? "top"}`}
												m={e.message}
												sub={Boolean(e.parentToolUseId)}
											/>
										))}
									</div>
								) : openCall ? (
									<div>
										<button
											type="button"
											className="rail-btn"
											onClick={() => setOpenCall(null)}
										>
											← calls
										</button>
										<LlmCallDetailView c={openCall} />
									</div>
								) : (
									<div className="calls-list">
										{calls.length === 0 && (
											<p className="mut">No LLM calls logged for this turn.</p>
										)}
										{calls.map((c) => (
											<button
												type="button"
												key={c.index}
												className="call-row"
												onClick={() => openCallDetail(c.index)}
											>
												<span className="call-i">#{c.index}</span>
												<span className="call-model">{c.model}</span>
												{c.isReflection && <span className="tag">refl</span>}
												<span className="mut">
													{fmtTok(c.usage?.input)}→{fmtTok(c.usage?.output)}
												</span>
												<span className="call-cost">
													{fmtUsd(c.cost?.totalUsd)}
													{c.costEstimated ? "~" : ""}
												</span>
												<span className="mut">{c.stopReason ?? ""}</span>
												{!c.hasBody && <span className="mut">(pruned)</span>}
											</button>
										))}
									</div>
								)}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
