import { useState } from "react";
import {
	type AppAction,
	controlMissionApp,
	fetchApps,
	type MissionApp,
	openMissionApp,
} from "./data";
import { useApiResource } from "./use-api-resource";

const KIND_LABEL: Record<MissionApp["kind"], string> = {
	jupyter: "Notebook",
	gradio: "Gradio app",
	site: "Website",
};

/**
 * A mission's interactive apps (ADR-0037): what agents serve, their state,
 * and Open (a new tab on the apps host), Start, Stop and Remove.
 */
export function AppsPanel({ missionId }: { missionId: string | null }) {
	const { resource, reload } = useApiResource(missionId, fetchApps);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [links, setLinks] = useState<Record<string, string>>({});

	if (!missionId)
		return <p className="mut">Select a live mission to see its apps.</p>;
	if (resource.status === "loading") return <p className="mut">Loading…</p>;
	if (resource.status === "error")
		return (
			<p className="error-msg">
				Could not load the apps (is the mission running?): {resource.message}
			</p>
		);

	async function open(name: string) {
		if (!missionId) return;
		// Opened at once, in the click, so the browser does not block it as a popup.
		const tab = window.open("", "_blank");
		// The app is another site's code: it gets no handle back to the cockpit.
		if (tab) tab.opener = null;
		setBusy(name);
		setError(null);
		try {
			const r = await openMissionApp(missionId, name);
			if (tab) tab.location.href = r.url;
			else window.location.href = r.url;
			setLinks((l) => ({ ...l, [name]: r.link }));
		} catch (e) {
			tab?.close();
			setError((e as Error).message);
		} finally {
			setBusy(null);
			reload();
		}
	}

	async function control(name: string, action: AppAction) {
		if (!missionId) return;
		if (
			action === "remove" &&
			!window.confirm(`Remove the app ${name}? Its owner is told.`)
		)
			return;
		setBusy(name);
		setError(null);
		try {
			await controlMissionApp(missionId, name, action);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(null);
			reload();
		}
	}

	const apps = resource.data;
	return (
		<div className="apps-panel">
			{error && <p className="error-msg">{error}</p>}
			{apps.length === 0 && (
				<p className="mut">
					No apps yet. Agents serve notebooks, Gradio apps and small websites
					here with the serve-app skill.
				</p>
			)}
			{apps.length > 0 && (
				<table className="schedule-table">
					<thead>
						<tr>
							<th>App</th>
							<th>Owner</th>
							<th>State</th>
							<th>Memory</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{apps.map((a) => (
							<AppRow
								key={a.name}
								app={a}
								busy={busy === a.name}
								link={links[a.name]}
								onOpen={() => open(a.name)}
								onControl={(action) => control(a.name, action)}
							/>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

/** One app's row: what it is, its state, and its controls. */
function AppRow({
	app: a,
	busy,
	link,
	onOpen,
	onControl,
}: {
	app: MissionApp;
	busy: boolean;
	link: string | undefined;
	onOpen: () => void;
	onControl: (action: AppAction) => void;
}) {
	return (
		<tr>
			<td>
				<strong>{a.name}</strong>{" "}
				<span className="mut">{KIND_LABEL[a.kind]}</span>
				{a.description && <div className="mut">{a.description}</div>}
				{link && (
					<div className="mut">
						Link for this browser:{" "}
						<button
							type="button"
							className="rail-btn"
							onClick={() => navigator.clipboard.writeText(link)}
						>
							Copy
						</button>
					</div>
				)}
			</td>
			<td>{a.owner}</td>
			<td>
				{a.status}
				{a.status === "failed" && a.lastError && (
					<div className="error-msg">{a.lastError}</div>
				)}
				{a.lastOpenedAt && (
					<div className="mut">
						opened {new Date(a.lastOpenedAt).toLocaleString()}
					</div>
				)}
			</td>
			<td className="mut">{a.rssMb !== undefined ? `${a.rssMb} MB` : "—"}</td>
			<td>
				<button
					type="button"
					className="rail-btn"
					disabled={busy}
					onClick={onOpen}
				>
					{busy ? "Opening…" : "Open"}
				</button>{" "}
				{a.status === "running" || a.status === "starting" ? (
					<button
						type="button"
						className="rail-btn"
						disabled={busy}
						onClick={() => onControl("stop")}
					>
						Stop
					</button>
				) : (
					<button
						type="button"
						className="rail-btn"
						disabled={busy}
						onClick={() => onControl("start")}
					>
						Start
					</button>
				)}{" "}
				<button
					type="button"
					className="rail-btn"
					disabled={busy}
					onClick={() => onControl("remove")}
				>
					Remove
				</button>
			</td>
		</tr>
	);
}
