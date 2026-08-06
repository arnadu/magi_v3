import { useEffect, useState } from "react";
import {
	fetchTemplate,
	fetchTemplates,
	type TemplateDetail,
	type TemplateSummary,
} from "./data";

/** Read-only browse + launch — templates are immutable/disk-only (ADR-0021/0022), no editor. */
export function TemplatesPanel({
	onLaunch,
}: {
	onLaunch: (templateId: string) => void;
}) {
	const [templates, setTemplates] = useState<
		TemplateSummary[] | "error" | null
	>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<TemplateDetail | "error" | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetchTemplates()
			.then((t) => {
				if (cancelled) return;
				setTemplates(t);
				if (t.length > 0) setSelectedId(t[0].id);
			})
			.catch(() => {
				if (!cancelled) setTemplates("error");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!selectedId) return;
		let cancelled = false;
		setDetail(null);
		fetchTemplate(selectedId)
			.then((d) => {
				if (!cancelled) setDetail(d);
			})
			.catch(() => {
				if (!cancelled) setDetail("error");
			});
		return () => {
			cancelled = true;
		};
	}, [selectedId]);

	if (templates === null) {
		return (
			<main>
				<p className="mut">Loading templates…</p>
			</main>
		);
	}
	if (templates === "error") {
		return (
			<main>
				<p className="error-msg">Could not load templates.</p>
			</main>
		);
	}

	return (
		<main className="templates-main">
			<div className="templates-list">
				<h2 className="sec">Templates</h2>
				{templates.length === 0 && <p className="mut">No templates found.</p>}
				<ul className="templates-ul">
					{templates.map((t) => (
						<li key={t.id}>
							<button
								type="button"
								className={`template-row-btn${t.id === selectedId ? " template-row-selected" : ""}`}
								onClick={() => setSelectedId(t.id)}
							>
								{t.name}
							</button>
						</li>
					))}
				</ul>
			</div>
			<div className="template-detail">
				{detail === null && selectedId && <p className="mut">Loading…</p>}
				{detail === "error" && (
					<p className="error-msg">Could not load this template.</p>
				)}
				{detail && detail !== "error" && (
					<>
						<div className="template-detail-header">
							<h3>{detail.name}</h3>
							<button
								type="button"
								className="btn-primary"
								onClick={() => onLaunch(detail.id)}
							>
								Launch
							</button>
						</div>
						<dl className="template-meta">
							<dt>Model</dt>
							<dd>{detail.config.mission.model ?? "default"}</dd>
							<dt>Agents</dt>
							<dd>{detail.config.agents.length}</dd>
							<dt>Files</dt>
							<dd>{detail.teamFiles.length}</dd>
						</dl>
						<h4 className="template-roster-title">Roster</h4>
						<ul className="template-roster">
							{detail.config.agents.map((a) => (
								<li key={a.id}>
									<span className="template-agent-name">{a.name ?? a.id}</span>
									{a.role && <span className="mut"> — {a.role}</span>}
									<span className="mut template-agent-supervisor">
										{" "}
										reports to {a.supervisor}
									</span>
								</li>
							))}
						</ul>
					</>
				)}
			</div>
		</main>
	);
}
