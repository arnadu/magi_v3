import { useEffect, useRef, useState } from "react";
import {
	type Agent,
	fetchAgents,
	fetchLlmCall,
	fetchLlmCalls,
	fetchTranscript,
	fetchTurns,
	type LlmCallSummary,
	type TranscriptEntry,
	type TurnSummary,
} from "../data";
import type { CallDetailState, TurnJump } from "../TranscriptsPanel";

const AGENTS_POLL_MS = 5000;

/**
 * The Transcripts panel's data: the roster (polled), the selected agent's
 * turns, and the selected turn's transcript and LLM calls, with call bodies
 * loaded lazily by `ensureDetail`.
 */
export function useTranscriptData(
	missionId: string | null,
	failed: (what: string) => (e: unknown) => void,
	opts: {
		jumpTo?: TurnJump | null;
		onJumped?: () => void;
		runningAgents?: Set<string>;
	},
) {
	const { jumpTo, onJumped, runningAgents } = opts;
	const [agents, setAgents] = useState<Agent[]>([]);
	const [agent, setAgent] = useState<string | null>(null);
	const [turns, setTurns] = useState<TurnSummary[]>([]);
	const [turn, setTurn] = useState<number | null>(null);
	const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
	const [calls, setCalls] = useState<LlmCallSummary[]>([]);
	const [detail, setDetail] = useState<Record<number, CallDetailState>>({});

	useEffect(() => {
		if (!missionId) return;
		const loadAgents = () =>
			fetchAgents(missionId).then(setAgents, failed("Loading the roster"));
		loadAgents();
		// Poll rather than fetch once — see ConversationsPanel's identical fix
		// (github#26): a one-shot fetch landing right after a daemon crash
		// restart can cache a roster missing the mission-copilot for the rest
		// of the session.
		const t = setInterval(loadAgents, AGENTS_POLL_MS);
		return () => clearInterval(t);
	}, [missionId, failed]);

	useEffect(() => {
		if (missionId && agent)
			fetchTurns(missionId, agent).then(setTurns, failed("Loading turns"));
		else setTurns([]);
		setTurn(null);
	}, [missionId, agent, failed]);

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
			fetchLlmCalls(missionId, agent, turn).then(
				setCalls,
				failed("Loading LLM calls"),
			);
		} else {
			setTranscript([]);
			setCalls([]);
		}
	}, [missionId, agent, turn, failed]);

	const ensureDetail = (i: number) => {
		if (detail[i] !== undefined || !missionId || !agent || turn == null) return;
		setDetail((d) => ({ ...d, [i]: "loading" }));
		fetchLlmCall(missionId, agent, turn, i).then(
			(full) => setDetail((d) => ({ ...d, [i]: full })),
			() => setDetail((d) => ({ ...d, [i]: null })),
		);
	};

	return {
		agents,
		agent,
		setAgent,
		turns,
		turn,
		setTurn,
		transcript,
		calls,
		detail,
		ensureDetail,
	};
}
