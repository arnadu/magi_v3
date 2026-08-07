import { useEffect, useState } from "react";
import {
	fetchCopilotLlmCall,
	fetchCopilotLlmCalls,
	fetchCopilotTranscript,
	fetchCopilotTurns,
	type LlmCallSummary,
	type TranscriptEntry,
	type TurnSummary,
} from "./data";
import {
	type CallDetailState,
	LlmCallView,
	MessageView,
	TurnRow,
	toolCallsIn,
} from "./TranscriptsPanel";

/**
 * The copilot's own turn-by-turn transcript — same visual language as the
 * mission Transcripts tab, but no agent-chip bar (the copilot is a single
 * agent) and no jumpTo/runningAgents deep-link plumbing, neither of which
 * applies outside a mission context.
 */
export function CopilotTranscriptsPanel() {
	const [turns, setTurns] = useState<TurnSummary[]>([]);
	const [turn, setTurn] = useState<number | null>(null);
	const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
	const [calls, setCalls] = useState<LlmCallSummary[]>([]);
	const [detail, setDetail] = useState<Record<number, CallDetailState>>({});

	useEffect(() => {
		fetchCopilotTurns().then(setTurns, () => setTurns([]));
	}, []);

	useEffect(() => {
		setDetail({});
		if (turn == null) {
			setTranscript([]);
			setCalls([]);
			return;
		}
		fetchCopilotTranscript(turn).then(setTranscript, () => setTranscript([]));
		fetchCopilotLlmCalls(turn).then(setCalls, () => setCalls([]));
	}, [turn]);

	const ensureDetail = (i: number) => {
		if (detail[i] !== undefined || turn == null) return;
		setDetail((d) => ({ ...d, [i]: "loading" }));
		fetchCopilotLlmCall(turn, i).then(
			(full) => setDetail((d) => ({ ...d, [i]: full })),
			() => setDetail((d) => ({ ...d, [i]: null })),
		);
	};

	// Group Research sub-loop messages under their parent tool call, same as
	// the mission Transcripts panel.
	const subByParent = new Map<string, TranscriptEntry[]>();
	for (const e of transcript) {
		if (!e.parentToolUseId) continue;
		const arr = subByParent.get(e.parentToolUseId) ?? [];
		arr.push(e);
		subByParent.set(e.parentToolUseId, arr);
	}
	const topLevel = transcript.filter((e) => !e.parentToolUseId);

	let asstSeq = -1;
	const callIndexFor = topLevel.map((e) =>
		e.message.role === "assistant" ? ++asstSeq : -1,
	);

	return (
		<div className="tx">
			<div className="tx-body">
				<div className="tx-turns">
					{turns.length === 0 && <p className="mut rail-pad">No turns yet.</p>}
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
		</div>
	);
}
