import { useState } from "react";
import { cancelScheduledMessage, fetchSchedule } from "./data";
import { useApiResource } from "./use-api-resource";

/** A mission's pending scheduled messages and jobs, with cancel. */
export function SchedulePanel({ missionId }: { missionId: string | null }) {
	const { resource, reload } = useApiResource(missionId, fetchSchedule);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (!missionId) {
		return <p className="mut">Select a live mission to see its schedule.</p>;
	}

	async function handleCancel(id: string) {
		if (!missionId) return;
		setBusyId(id);
		setError(null);
		try {
			await cancelScheduledMessage(missionId, id);
			reload();
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusyId(null);
		}
	}

	if (resource.status === "loading") {
		return <p className="mut">Loading…</p>;
	}
	if (resource.status === "error") {
		return (
			<p className="error-msg">
				Could not load the schedule: {resource.message}
			</p>
		);
	}
	const items = resource.data;

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
