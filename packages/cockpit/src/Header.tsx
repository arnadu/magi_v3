import { useEffect, useState } from "react";
import { useMissionName } from "./app-hooks";
import {
	fetchMissionStatus,
	type MissionStatusValue,
	resumeMission,
	suspendMission,
} from "./data";
import { SignOutButton } from "./SignOutButton";
import type { FoldedTree } from "./types";

/** Suspend/Resume toggle for the mission dashboard header — same action the Missions list already has, without needing to go back there. */
export function MissionStatusButton({ missionId }: { missionId: string }) {
	const [status, setStatus] = useState<MissionStatusValue | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchMissionStatus(missionId).then(
			(s) => {
				if (!cancelled) setStatus(s);
			},
			() => {
				if (!cancelled) setStatus(null);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [missionId]);

	async function handleClick() {
		if (status !== "running" && status !== "suspended") return;
		setBusy(true);
		setError(null);
		try {
			if (status === "running") {
				await suspendMission(missionId);
				setStatus("suspended");
			} else {
				await resumeMission(missionId);
				setStatus("running");
			}
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	}

	// Nothing sensible to toggle mid-transition (provisioning/error/destroyed).
	if (status !== "running" && status !== "suspended") return null;

	return (
		<>
			<button
				type="button"
				className="header-status-btn"
				disabled={busy}
				onClick={handleClick}
			>
				{busy ? "…" : status === "running" ? "⏸ Suspend" : "▶ Resume"}
			</button>
			{error && <span className="error-msg header-status-error">{error}</span>}
		</>
	);
}

export function Header({
	subtitle,
	tree,
	budgetPaused,
	onBack,
	missionId,
}: {
	subtitle: string;
	tree?: FoldedTree;
	budgetPaused?: boolean;
	/** Shown as a "← Missions" link when set — only the per-mission view has anywhere to go back to. */
	onBack?: () => void;
	/** Shows a Suspend/Resume toggle when set — same lifecycle action the Missions list already has, available without leaving the mission dashboard. */
	missionId?: string;
}) {
	const spent = tree ? tree.objectives.reduce((a, o) => a + o.costUsd, 0) : 0;
	const budget = tree
		? tree.objectives.reduce((a, o) => a + o.budgetUsd, 0)
		: 0;
	const missionName = useMissionName(missionId);
	return (
		<header>
			{onBack && (
				<button type="button" className="header-back-btn" onClick={onBack}>
					← Missions
				</button>
			)}
			<h1>
				<span className="dot" />{" "}
				{missionId
					? `Mission Cockpit — ${missionName ?? missionId}`
					: "MAGI Control Cockpit"}
			</h1>
			{missionId && <MissionStatusButton missionId={missionId} />}
			{tree && (
				<span className="mut">
					spend <b>{`$${spent.toFixed(2)}`}</b> / ${budget.toFixed(2)}
				</span>
			)}
			{budgetPaused && (
				<span className="badge badge-bad" title="See the Limits tab">
					⏸ budget paused
				</span>
			)}
			<span className="grow" />
			<span className="mut" style={{ fontSize: 11 }}>
				{subtitle}
			</span>
			<SignOutButton />
		</header>
	);
}
