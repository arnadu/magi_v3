import { useEffect, useState } from "react";
import {
	cancelScheduledMessage,
	fetchSchedule,
	type ScheduledMessage,
} from "./data";

/** Ported from the mission-local dashboard's Schedule tab (agent-runtime-worker/public/app.js) — no cockpit surface existed for this before. */
export function SchedulePanel({ missionId }: { missionId: string | null }) {
	const [items, setItems] = useState<ScheduledMessage[] | "error" | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is a deliberate manual-refetch trigger, not a value read inside the effect
	useEffect(() => {
		if (!missionId) return;
		let cancelled = false;
		fetchSchedule(missionId)
			.then((s) => {
				if (!cancelled) setItems(s);
			})
			.catch(() => {
				if (!cancelled) setItems("error");
			});
		return () => {
			cancelled = true;
		};
	}, [missionId, refreshKey]);

	if (!missionId) {
		return <p className="mut">Select a live mission to see its schedule.</p>;
	}

	async function handleCancel(id: string) {
		if (!missionId) return;
		setBusyId(id);
		setError(null);
		try {
			await cancelScheduledMessage(missionId, id);
			setRefreshKey((k) => k + 1);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyId(null);
		}
	}

	if (items === null) {
		return <p className="mut">Loading…</p>;
	}
	if (items === "error") {
		return <p className="error-msg">Could not load the schedule.</p>;
	}

	return (
		<div className="schedule-panel">
			{error && <p className="error-msg">{error}</p>}
			{items.length === 0 && <p className="mut">No scheduled messages.</p>}
			{items.length > 0 && (
				<table className="schedule-table">
					<thead>
						<tr>
							<th>When</th>
							<th>To</th>
							<th>Subject</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{items.map((s) => (
							<tr key={s.id}>
								<td className="mut">
									{s.cronExpression
										? `cron: ${s.cronExpression}`
										: s.scheduledFor
											? new Date(s.scheduledFor).toLocaleString()
											: "—"}
								</td>
								<td>{s.to.join(", ")}</td>
								<td>{s.subject}</td>
								<td>
									<button
										type="button"
										className="rail-btn"
										disabled={busyId === s.id}
										onClick={() => handleCancel(s.id)}
									>
										Cancel
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}
