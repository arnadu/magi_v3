// MAGI Monitor — app.js v2

const CTX_LIMIT = 200_000;

// ── State ──────────────────────────────────────────────────────────────────
let AGENTS = [];
let PLAYBOOK = [];
let activeAgent = null;
let feedMode = "all";        // all | threads | user
let feedSearch = "";
const agentContextTokens = {};
const agentCosts = {};
let missionStarted = false;
let stepEnabled = false;
let stepWaiting = false;
let runningAgent = null;
let pendingAgents = [];
let startedAt = Date.now();
let maxCostUsd = null;
let stopped = false;

// Feed data store (all messages, for re-filtering)
const allMessages = [];

// Sessions tree state
let sessionLiveDirty = false;

// Schedule data
let scheduleData = [];

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
	const [teamRes, statusRes, playbookRes, mailboxRes, scheduleRes] = await Promise.all([
		fetch("/team"), fetch("/status"), fetch("/playbook"),
		fetch("/mailbox"), fetch("/schedule"),
	]);
	AGENTS = await teamRes.json();
	PLAYBOOK = await playbookRes.json();
	const status = await statusRes.json();
	const history = await mailboxRes.json();
	scheduleData = await scheduleRes.json();

	populateAgentTabs(AGENTS);
	populateToChecks(AGENTS);
	injectAgentColors(AGENTS);
	applyStatus(status);
	updateScheduleTabs();

	for (const m of history) allMessages.push(m);
	renderFeed();

	setInterval(refreshSchedule, 60_000);
	connectSSE();
}

async function refreshSchedule() {
	try {
		const r = await fetch("/schedule");
		scheduleData = await r.json();
		updateScheduleTabs();
	} catch {}
}

// ── Agent tabs ─────────────────────────────────────────────────────────────
function populateAgentTabs(agents) {
	const bar = document.getElementById("agent-tabs");
	const playbook = document.getElementById("tab-playbook");
	agents.forEach(a => {
		const tab = document.createElement("div");
		tab.className = `agent-tab ac-${a.id}`;
		tab.dataset.id = a.id;
		tab.innerHTML =
			`<div class="tab-name">${esc(a.name)}</div>` +
			`<div class="tab-role">${esc(a.role)}</div>` +
			'<div class="tab-ctx">' +
			'<span class="tab-ctx-label">—</span>' +
			'<div class="tab-ctx-bar"><div class="tab-ctx-fill"></div></div>' +
			'</div>' +
			'<div class="tab-sched">—</div>';
		tab.onclick = () => selectAgent(a.id);
		bar.insertBefore(tab, playbook);
	});
}

function updateScheduleTabs() {
	AGENTS.forEach(a => {
		const tab = document.querySelector(`.agent-tab[data-id="${a.id}"]`);
		if (!tab) return;
		const sched = tab.querySelector(".tab-sched");
		if (!sched) return;
		if (a.id === runningAgent) {
			sched.textContent = "\u25b6 running";
			sched.style.color = "var(--green)";
			return;
		}
		const pending = scheduleData.filter(s =>
			Array.isArray(s.to) && s.to.includes(a.id));
		if (!pending.length) {
			sched.textContent = "\u2014";
			sched.style.color = "var(--muted)";
			return;
		}
		pending.sort((x, y) => new Date(x.scheduledFor) - new Date(y.scheduledFor));
		const next = pending[0];
		const t = next.scheduledFor ? new Date(next.scheduledFor) : null;
		if (t && !isNaN(t)) {
			const now = new Date();
			const isToday = t.toDateString() === now.toDateString();
			sched.textContent = "next: " + (isToday
				? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				: t.toLocaleDateString([], { weekday: "short" }) + " " +
				  t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
		} else if (next.cronExpression) {
			sched.textContent = "cron: " + next.cronExpression;
		} else {
			sched.textContent = "scheduled";
		}
		sched.style.color = "var(--muted)";
	});
}

function populateToChecks(agents) {
	const box = document.getElementById("to-checks");
	box.innerHTML = "";
	agents.forEach(a => {
		const lbl = document.createElement("label");
		const chk = document.createElement("input");
		chk.type = "checkbox"; chk.value = a.id; chk.id = `chk-${a.id}`;
		lbl.appendChild(chk);
		lbl.appendChild(document.createTextNode(` ${a.name} (${a.role})`));
		box.appendChild(lbl);
	});
	const all = document.createElement("label");
	all.style.cssText = "margin-left:auto;color:var(--muted);cursor:pointer";
	all.onclick = checkAll;
	all.textContent = "All";
	box.appendChild(all);
}

function injectAgentColors(agents) {
	const COLORS = ["--c0", "--c1", "--c2", "--c3", "--c4"];
	const lines = agents.map((a, i) => {
		const safe = a.id.replace(/-/g, "\\-");
		const color = `var(${COLORS[i] || "--muted"})`;
		return `.ac-${safe}{color:${color}} .ab-${safe}{border-left-color:${color}}`;
	});
	lines.push(".ac-scheduler{color:var(--c-sched)} .ab-scheduler{border-left-color:var(--c-sched)}");
	lines.push(".ac-user{color:var(--c-user)} .ab-user{border-left-color:var(--c-user)}");
	const style = document.createElement("style");
	style.textContent = lines.join("\n");
	document.head.appendChild(style);
}

// ── SSE ────────────────────────────────────────────────────────────────────
let es;
function connectSSE() {
	es = new EventSource("/events");
	es.onopen = () => document.getElementById("dot").classList.remove("dead");
	es.onerror = () => document.getElementById("dot").classList.add("dead");
	es.addEventListener("status", e => applyStatus(JSON.parse(e.data)));
	es.addEventListener("mailbox-msg", e => {
		const m = JSON.parse(e.data);
		allMessages.push(m);
		renderFeed();
	});
	es.addEventListener("llm-call", e => {
		const d = JSON.parse(e.data);
		updateCostDisplay(d.missionTotalUsd, maxCostUsd);
		addLlmCallToUsage(d);
		agentContextTokens[d.agentId] = d.input;
		updateContextBar(d.agentId, d.input);
	});
	es.addEventListener("step-paused", () => { stepWaiting = true; renderStepBtn(); renderQueue(); });
	es.addEventListener("step-resumed", () => { stepWaiting = false; renderStepBtn(); renderQueue(); });
	es.addEventListener("mental-map-update", () => {
		// Mental map snapshots are stored per-LLM-call in the sessions tree — no live rendering needed.
	});
	es.addEventListener("conversation-update", e => {
		const d = JSON.parse(e.data);
		if (d.agentId !== activeAgent) return;
		appendToSessionsLive(d.message);
	});
	es.addEventListener("shutdown", e => {
		const d = JSON.parse(e.data);
		document.getElementById("dot").classList.add("dead");
		document.getElementById("stop-btn").disabled = true;
		document.getElementById("stop-btn").textContent = "\u2014 stopped";
		addSysMsg(`Daemon stopped: ${d.reason || "unknown"}`);
		stopped = true;
	});
	es.addEventListener("started", () => setStarted(true));
	es.addEventListener("agent-status", e => {
		const d = JSON.parse(e.data);
		runningAgent = d.running;
		pendingAgents = d.pending ?? [];
		renderQueue();
		renderAgentTabIndicators();
		// Re-fetch sessions when agent finishes if live updates arrived
		if (!d.running && activeAgent && sessionLiveDirty) {
			sessionLiveDirty = false;
			loadSessions();
		}
	});
	es.addEventListener("cost-pause", e => {
		const d = JSON.parse(e.data);
		showBudgetBanner(d.spentUsd, d.capUsd);
	});
	es.addEventListener("cost-resumed", e => {
		const d = JSON.parse(e.data);
		hideBudgetBanner();
		maxCostUsd = d.newCapUsd ?? maxCostUsd;
		addSysMsg(`\u2705 Budget extended +$${d.addUsd?.toFixed(2) ?? "5.00"} \u2014 new cap $${d.newCapUsd?.toFixed(2) ?? "?"}, mission resuming`);
	});
}

// ── Status ─────────────────────────────────────────────────────────────────
function applyStatus(s) {
	document.getElementById("hname").textContent = s.missionName || s.missionId;
	document.getElementById("hmeta").textContent = s.model;
	startedAt = Date.now() - s.uptimeSec * 1000;
	maxCostUsd = s.maxCostUsd;
	stepEnabled = s.stepEnabled;
	runningAgent = s.running ?? null;
	pendingAgents = s.pending ?? [];
	if (s.started) setStarted(true);
	if (s.budgetPaused) showBudgetBanner(s.missionTotalUsd, s.maxCostUsd);
	else hideBudgetBanner();
	renderStepBtn();
	renderQueue();
	renderAgentTabIndicators();
	updateCostDisplay(s.missionTotalUsd, s.maxCostUsd);
	updateUsageTable(s.agents);
}

function setStarted(val) {
	missionStarted = val;
	const btn = document.getElementById("start-btn");
	if (val) {
		btn.textContent = "\u25cf Running";
		btn.className = "btn btn-start running";
		btn.disabled = true;
	}
}

function updateCostDisplay(total, max) {
	const el = document.getElementById("hcost");
	el.textContent = `$${total.toFixed(4)}`;
	el.className = "hcost";
	if (max && total > max * 0.8) el.classList.add("warn");
	if (max && total >= max) el.classList.add("danger");
}

// ── Budget pause banner ────────────────────────────────────────────────────
function showBudgetBanner(spentUsd, capUsd) {
	const banner = document.getElementById("budget-banner");
	const msg = document.getElementById("budget-banner-msg");
	msg.textContent = `Spending cap of $${capUsd.toFixed(2)} reached ($${spentUsd.toFixed(4)} spent) — mission paused`;
	banner.classList.remove("hidden");
	document.getElementById("hcost").classList.add("danger");
	addSysMsg(`\u26a0 Spending cap $${capUsd.toFixed(2)} reached — mission paused. Click "+$5 and continue" to resume.`);
}

function hideBudgetBanner() {
	document.getElementById("budget-banner").classList.add("hidden");
	document.getElementById("hcost").classList.remove("danger");
	const btn = document.getElementById("extend-budget-btn");
	btn.disabled = false;
	btn.textContent = "+$5 and continue";
}

async function extendBudget() {
	const btn = document.getElementById("extend-budget-btn");
	btn.disabled = true;
	btn.textContent = "Extending\u2026";
	try {
		const r = await fetch("/extend-budget", { method: "POST" });
		if (!r.ok) {
			btn.disabled = false;
			btn.textContent = "+$5 and continue";
			addSysMsg(`\u274c Failed to extend budget: ${r.statusText}`);
		}
		// Banner hidden via cost-resumed SSE event
	} catch (err) {
		btn.disabled = false;
		btn.textContent = "+$5 and continue";
		addSysMsg(`\u274c Error: ${err.message}`);
	}
}

function updateContextBar(agentId, tokens) {
	const tab = document.querySelector(`.agent-tab[data-id="${agentId}"]`);
	if (!tab) return;
	const label = tab.querySelector(".tab-ctx-label");
	const fill = tab.querySelector(".tab-ctx-fill");
	if (!label || !fill) return;
	const pct = Math.min(100, (tokens / CTX_LIMIT) * 100);
	label.textContent = tokens >= 1000 ? `${(tokens / 1000).toFixed(0)}k` : String(tokens);
	fill.style.width = `${pct}%`;
	fill.style.background = pct > 80 ? "var(--red)" : pct > 60 ? "var(--yellow)" : "var(--green)";
}

// ── Usage bar (footer) ─────────────────────────────────────────────────────
function addLlmCallToUsage(d) {
	agentCosts[d.agentId] = d.agentTotalUsd;
	renderUsageRow();
	if (maxCostUsd) {
		document.getElementById("cap-wrap").style.display = "block";
		const pct = Math.min(100, (d.missionTotalUsd / maxCostUsd) * 100);
		const fill = document.getElementById("cap-fill");
		fill.style.width = `${pct}%`;
		fill.style.background = pct > 80 ? "var(--red)" : pct > 50 ? "var(--yellow)" : "var(--accent)";
	}
}

function updateUsageTable(agents) {
	if (!agents || !agents.length) return;
	for (const a of agents) agentCosts[a.agentId] = a.costUsd;
	renderUsageRow();
}

function renderUsageRow() {
	const total = Object.values(agentCosts).reduce((s, v) => s + v, 0);
	const row = document.getElementById("usage-row");
	row.innerHTML = Object.entries(agentCosts)
		.sort((a, b) => b[1] - a[1])
		.map(([id, cost]) =>
			`<span><span class="u-agent ac-${id}">${id}</span> <span class="u-val">$${cost.toFixed(4)}</span></span>`)
		.join("") + `<span class="u-total">mission $${total.toFixed(4)}</span>`;
}

// ── Feed ───────────────────────────────────────────────────────────────────
function setFeedMode(mode) {
	feedMode = mode;
	document.querySelectorAll(".feed-mode-btn").forEach(b =>
		b.classList.toggle("active", b.dataset.mode === mode));
	renderFeed();
}

function setFeedSearch(text) {
	feedSearch = text.toLowerCase();
	renderFeed();
}

function matchesSearch(m) {
	if (!feedSearch) return true;
	return [m.from, ...(m.to || []), m.subject || "", m.body || ""]
		.some(s => String(s).toLowerCase().includes(feedSearch));
}

function renderFeed() {
	const feed = document.getElementById("feed");
	const msgs = allMessages.filter(m => {
		if (feedMode === "user" && !(m.to || []).includes("user")) return false;
		return matchesSearch(m);
	});
	feed.innerHTML = "";
	if (!msgs.length) {
		feed.innerHTML = '<div class="empty-state">No messages</div>';
		return;
	}
	if (feedMode === "threads") {
		renderFeedThreads(feed, msgs);
	} else {
		for (const m of msgs) _appendMsgEl(feed, m);
		feed.scrollTop = feed.scrollHeight;
	}
}

function renderFeedThreads(feed, msgs) {
	const threads = new Map();
	for (const m of msgs) {
		const key = (m.subject || "(no subject)").toLowerCase().trim();
		if (!threads.has(key)) threads.set(key, []);
		threads.get(key).push(m);
	}
	const sorted = [...threads.entries()]
		.sort((a, b) => new Date(b[1].at(-1).timestamp) - new Date(a[1].at(-1).timestamp));
	for (const [, tMsgs] of sorted) {
		const participants = [...new Set(tMsgs.flatMap(m => [m.from, ...(m.to || [])]))];
		const last = tMsgs.at(-1);
		const thread = document.createElement("div");
		thread.className = "feed-thread";
		thread.innerHTML =
			`<div class="feed-thread-hdr" onclick="toggleThread(this)">` +
			`<span class="ft-arrow">\u25b6</span>` +
			`<span class="ft-subj">${esc(tMsgs[0].subject || "(no subject)")}</span>` +
			`<span class="ft-meta">${tMsgs.length}\u00a0msg \u00b7 ${esc(participants.join(", "))} \u00b7 ${fmtTime(last.timestamp)}</span>` +
			`</div><div class="feed-thread-body"></div>`;
		const body = thread.querySelector(".feed-thread-body");
		for (const m of tMsgs) _appendMsgEl(body, m);
		feed.appendChild(thread);
	}
}

function toggleThread(hdr) {
	const body = hdr.nextElementSibling;
	const arrow = hdr.querySelector(".ft-arrow");
	body.classList.toggle("open");
	arrow.textContent = body.classList.contains("open") ? "\u25bc" : "\u25b6";
}

function _appendMsgEl(container, m) {
	const preview = m.bodyPreview || m.body || "";
	const full = m.body || preview;
	const truncated = full.length > preview.length;
	const div = document.createElement("div");
	div.className = `msg ab-${m.from}`;
	div.innerHTML =
		'<div class="msg-hdr">' +
		`<span class="msg-from ac-${m.from}">${esc(m.from)}</span>` +
		`<span class="msg-to">\u2192 ${esc((m.to || []).join(", "))}</span>` +
		`<span class="msg-time">${fmtTime(m.timestamp)}</span>` +
		'</div>' +
		`<div class="msg-subj">${esc(m.subject || "")}</div>` +
		`<div class="msg-body">${esc(preview)}</div>` +
		(truncated ? '<div class="msg-expand">\u25bc\u00a0more</div>' : "");
	if (truncated) {
		div.style.cursor = "pointer";
		div.addEventListener("click", () => {
			const bodyEl = div.querySelector(".msg-body");
			const expandEl = div.querySelector(".msg-expand");
			if (div.dataset.expanded) {
				bodyEl.textContent = preview;
				expandEl.textContent = "\u25bc\u00a0more";
				delete div.dataset.expanded;
			} else {
				bodyEl.textContent = full;
				expandEl.textContent = "\u25b2\u00a0less";
				div.dataset.expanded = "1";
			}
		});
	}
	container.appendChild(div);
}

function addSysMsg(text) {
	const feed = document.getElementById("feed");
	const div = document.createElement("div");
	div.className = "msg";
	div.innerHTML = `<div class="msg-sys">${esc(text)}</div>`;
	feed.appendChild(div);
	feed.scrollTop = feed.scrollHeight;
}

// ── Agent detail ───────────────────────────────────────────────────────────
function selectAgent(id) {
	activeAgent = id;
	sessionLiveDirty = false;
	document.querySelectorAll(".agent-tab").forEach(t =>
		t.classList.toggle("active", t.dataset.id === id));
	document.getElementById("tab-playbook").classList.remove("active");
	loadSessions();
}

function resetPane() {
	const pane = document.getElementById("detail-pane");
	pane.style.padding = "10px";
	pane.style.overflow = "auto";
	pane.style.display = "";
	pane.style.gridTemplateColumns = "";
	pane.innerHTML = "";
	return pane;
}

// ── Sessions tree tab ─────────────────────────────────────────────────────

// State for expanded sessions
const expandedSessions = new Set();

async function loadSessions() {
	const pane = resetPane();
	pane.innerHTML = '<div class="empty-state">Loading…</div>';

	const r = await fetch(`/agents/${activeAgent}/sessions`);
	const sessions = await r.json();
	renderSessionTree(sessions, pane);
}

function renderSessionTree(sessions, pane) {
	pane.innerHTML = "";
	if (!sessions.length) {
		pane.innerHTML = '<div class="empty-state">No sessions yet</div>';
		return;
	}
	const tree = document.createElement("div");
	tree.className = "session-tree";
	for (const s of sessions) {
		tree.appendChild(renderSessionRow(s));
	}
	pane.appendChild(tree);
}

function renderSessionRow(session) {
	const wrap = document.createElement("div");
	wrap.dataset.turn = session.turnNumber;

	const isExpanded = expandedSessions.has(session.turnNumber);
	const hdr = document.createElement("div");
	hdr.className = "session-row" + (session.isReflection ? " reflection" : "") + (isExpanded ? " expanded" : "");

	const badge = session.isReflection
		? '<span class="sr-badge reflection">↺ Reflection</span>'
		: `<span class="sr-badge">Session ${session.turnNumber}</span>`;
	const time = session.startTime ? fmtTime(session.startTime) : "";
	const dur = session.durationMs > 0 ? `${(session.durationMs / 1000).toFixed(0)}s` : "";
	const tok = session.inputTokens > 0 ? `${Math.round(session.inputTokens / 1000)}k in` : "";
	const cost = session.costUsd > 0 ? `$${session.costUsd.toFixed(4)}` : "";
	const calls = session.llmCalls > 0 ? `${session.llmCalls} LLM` : "";
	const tools = session.toolCalls > 0 ? `${session.toolCalls} tools` : "";

	hdr.innerHTML =
		`<span class="sr-label">${badge}</span>` +
		`<span class="sr-meta">` +
		[time, dur, calls, tools, tok, cost].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join("") +
		`</span>` +
		`<span class="sr-arrow">${isExpanded ? "▼" : "▶"}</span>`;

	const detail = document.createElement("div");
	detail.className = "session-detail";
	detail.style.display = isExpanded ? "" : "none";

	hdr.onclick = async () => {
		const nowExpanded = expandedSessions.has(session.turnNumber);
		if (nowExpanded) {
			expandedSessions.delete(session.turnNumber);
			hdr.classList.remove("expanded");
			hdr.querySelector(".sr-arrow").textContent = "▶";
			detail.style.display = "none";
		} else {
			expandedSessions.add(session.turnNumber);
			hdr.classList.add("expanded");
			hdr.querySelector(".sr-arrow").textContent = "▼";
			detail.style.display = "";
			if (!detail.dataset.loaded) {
				detail.innerHTML = '<div class="empty-state">Loading…</div>';
				await expandSession(activeAgent, session.turnNumber, detail);
				detail.dataset.loaded = "1";
			}
		}
	};

	wrap.appendChild(hdr);
	wrap.appendChild(detail);

	if (isExpanded && !detail.dataset.loaded) {
		detail.innerHTML = '<div class="empty-state">Loading…</div>';
		expandSession(activeAgent, session.turnNumber, detail).then(() => {
			detail.dataset.loaded = "1";
		});
	}

	return wrap;
}

/**
 * Reconstruct callSeq for documents that predate the callSeq field.
 * Scans messages in seqInTurn order: each AssistantMessage starts a new
 * LLM call group; ToolResult messages inherit the preceding callSeq.
 * Documents that already have callSeq are returned unchanged.
 */
function normalizeCallSeq(docs) {
	// If every doc already has callSeq, nothing to do.
	if (docs.every(d => d.callSeq != null)) return docs;
	const sorted = [...docs].sort((a, b) => (a.seqInTurn ?? 0) - (b.seqInTurn ?? 0));
	let seq = -1;
	return sorted.map(doc => {
		if (doc.parentToolUseId) return doc; // sub-loop message — keep as-is
		const role = doc.message?.role;
		if (role === "assistant") seq++;
		return { ...doc, callSeq: role === "user" ? -1 : seq };
	});
}

async function expandSession(agentId, turnNumber, container) {
	const r = await fetch(`/agents/${encodeURIComponent(agentId)}/sessions/${turnNumber}`);
	const data = await r.json();
	container.innerHTML = "";

	const messages = normalizeCallSeq(data.messages || []);
	const llmCalls = data.llmCalls || [];

	// Group messages by callSeq
	const byCallSeq = new Map();
	for (const doc of messages) {
		const seq = doc.callSeq != null ? doc.callSeq : -1;
		if (!byCallSeq.has(seq)) byCallSeq.set(seq, []);
		byCallSeq.get(seq).push(doc);
	}

	// Build map of sub-loop messages by parentToolUseId
	const subLoopByToolId = new Map();
	for (const doc of messages) {
		if (doc.parentToolUseId) {
			if (!subLoopByToolId.has(doc.parentToolUseId)) subLoopByToolId.set(doc.parentToolUseId, []);
			subLoopByToolId.get(doc.parentToolUseId).push(doc);
		}
	}

	// Sort llmCalls by savedAt to match callSeq order
	const sortedLlmCalls = [...llmCalls].sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
	const llmCallBySeq = new Map();
	sortedLlmCalls.forEach((lc, i) => llmCallBySeq.set(i, lc));

	// Render task user message (callSeq = -1)
	const taskDocs = byCallSeq.get(-1) || [];
	for (const doc of taskDocs) {
		if (doc.message && doc.message.role === "user") {
			const el = document.createElement("div");
			el.className = "st-task-msg";
			const content = typeof doc.message.content === "string"
				? doc.message.content
				: (doc.message.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
			el.innerHTML = `<span class="st-task-label">Inbox</span><span class="st-task-body">${esc(content.slice(0, 300))}${content.length > 300 ? "…" : ""}</span>`;
			container.appendChild(el);
		}
	}

	// Render LLM call groups (callSeq 0, 1, 2, ...)
	const seqs = [...byCallSeq.keys()].filter(s => s >= 0).sort((a, b) => a - b);
	for (const seq of seqs) {
		const seqDocs = (byCallSeq.get(seq) || []).filter(d => !d.parentToolUseId);
		const llmMeta = llmCallBySeq.get(seq);
		const node = renderLlmCallGroup(seq, seqDocs, llmMeta, subLoopByToolId);
		container.appendChild(node);
	}

	if (!seqs.length && !taskDocs.length) {
		container.innerHTML = '<div class="empty-state">No messages in this session</div>';
	}
}

function renderLlmCallGroup(callSeq, docs, llmMeta, subLoopByToolId) {
	const wrap = document.createElement("div");
	wrap.className = "llm-call-node";

	const assistantDoc = docs.find(d => d.message && d.message.role === "assistant");
	const toolResultDocs = docs.filter(d => d.message && d.message.role === "toolResult");

	const hdr = document.createElement("div");
	hdr.className = "llm-call-hdr";
	const inputTok = llmMeta && llmMeta.usage ? llmMeta.usage.inputTokens || 0 : 0;
	const outputTok = llmMeta && llmMeta.usage ? llmMeta.usage.outputTokens || 0 : 0;
	const callCost = llmMeta && llmMeta.usage && llmMeta.usage.cost ? llmMeta.usage.cost.total || 0 : 0;
	hdr.innerHTML =
		`<span class="lc-label">LLM call ${callSeq}</span>` +
		`<span class="lc-meta">` +
		(inputTok > 0 ? `<span>${Math.round(inputTok / 1000)}k in</span>` : "") +
		(outputTok > 0 ? `<span>${Math.round(outputTok / 1000)}k out</span>` : "") +
		(callCost > 0 ? `<span class="lc-cost">$${callCost.toFixed(4)}</span>` : "") +
		`</span>` +
		`<span class="lc-arrow">▶</span>`;

	const body = document.createElement("div");
	body.className = "llm-call-body";
	body.style.display = "none";

	hdr.onclick = () => {
		const open = body.style.display !== "none";
		body.style.display = open ? "none" : "";
		hdr.querySelector(".lc-arrow").textContent = open ? "▶" : "▼";
		if (!open && !body.dataset.filled) {
			body.dataset.filled = "1";
			fillLlmCallBody(body, assistantDoc, toolResultDocs, subLoopByToolId, llmMeta);
		}
	};

	wrap.appendChild(hdr);
	wrap.appendChild(body);
	return wrap;
}

function fillLlmCallBody(body, assistantDoc, toolResultDocs, subLoopByToolId, llmMeta) {
	if (!assistantDoc) return;
	const m = assistantDoc.message;
	if (!m) return;

	const blocks = Array.isArray(m.content) ? m.content : [];
	const texts = blocks.filter(b => b.type === "text" && b.text && b.text.trim());
	if (texts.length) {
		const el = document.createElement("div");
		el.className = "lc-text";
		el.textContent = texts.map(b => b.text).join("\n\n").slice(0, 600);
		body.appendChild(el);
	}

	if (assistantDoc.mentalMapHtml) {
		const diffRow = document.createElement("div");
		diffRow.className = "lc-mm-row";
		diffRow.innerHTML = '<span class="lc-mm-label">🧠 Mental Map</span><span class="lc-mm-arrow">▶</span>';
		const diffBody = document.createElement("div");
		diffBody.style.display = "none";
		diffRow.onclick = () => {
			const open = diffBody.style.display !== "none";
			diffBody.style.display = open ? "none" : "";
			diffRow.querySelector(".lc-mm-arrow").textContent = open ? "▶" : "▼";
			if (!open && !diffBody.dataset.filled) {
				diffBody.dataset.filled = "1";
				diffBody.innerHTML = `<div class="mm-snapshot"><pre>${esc(assistantDoc.mentalMapHtml.slice(0, 1000))}${assistantDoc.mentalMapHtml.length > 1000 ? "…" : ""}</pre></div>`;
			}
		};
		body.appendChild(diffRow);
		body.appendChild(diffBody);
	}

	const toolCalls = blocks.filter(b => b.type === "toolCall");
	for (const call of toolCalls) {
		const resultDoc = toolResultDocs.find(d => d.message && d.message.toolCallId === call.id);
		const subMsgs = subLoopByToolId.get(call.id) || [];
		body.appendChild(renderToolCallRow(call, resultDoc, subMsgs));
	}
}

function renderToolCallRow(toolCallBlock, toolResultDoc, subLoopMessages) {
	const wrap = document.createElement("div");
	wrap.className = "tool-call-node";

	const argsStr = JSON.stringify(toolCallBlock.arguments || {});
	const argPreview = argsStr.length > 80 ? argsStr.slice(0, 80) + "…" : argsStr;
	const result = toolResultDoc ? toolResultDoc.message : null;
	const resultText = result
		? (result.content || []).filter(b => b.type === "text").map(b => b.text).join("").slice(0, 80)
		: "";
	const isError = result ? result.isError || false : false;

	const hdr = document.createElement("div");
	hdr.className = "tool-call-hdr";
	hdr.innerHTML =
		`<span class="tc-icon">${_toolIcon(toolCallBlock.name)}</span>` +
		`<span class="tc-name">${esc(toolCallBlock.name)}</span>` +
		`<span class="tc-arg">${esc(argPreview)}</span>` +
		(result ? `<span class="tc-status ${isError ? "err" : "ok"}">${isError ? "✗" : "✓"} ${esc(resultText)}</span>` : "") +
		(subLoopMessages.length ? `<span class="tc-sub">${subLoopMessages.length} sub-loop msgs</span>` : "") +
		`<span class="tc-arrow">▶</span>`;

	const bdy = document.createElement("div");
	bdy.style.display = "none";

	hdr.onclick = () => {
		const open = bdy.style.display !== "none";
		bdy.style.display = open ? "none" : "";
		hdr.querySelector(".tc-arrow").textContent = open ? "▶" : "▼";
		if (!open && !bdy.dataset.filled) {
			bdy.dataset.filled = "1";
			const argsEl = document.createElement("pre");
			argsEl.className = "tc-full-args";
			argsEl.textContent = JSON.stringify(toolCallBlock.arguments || {}, null, 2).slice(0, 500);
			bdy.appendChild(argsEl);
			if (result) {
				const fullResult = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("");
				const resEl = document.createElement("pre");
				resEl.className = `tc-full-result ${isError ? "err" : "ok"}`;
				resEl.textContent = fullResult.slice(0, 1000) + (fullResult.length > 1000 ? "…" : "");
				bdy.appendChild(resEl);
			}
			if (subLoopMessages.length) {
				const subHdr = document.createElement("div");
				subHdr.className = "sub-loop-hdr";
				subHdr.textContent = `Research sub-loop (${subLoopMessages.length} messages)`;
				bdy.appendChild(subHdr);
				for (const sub of subLoopMessages.slice(0, 20)) {
					const subEl = document.createElement("div");
					subEl.className = "sub-loop-node";
					const role = sub.message ? sub.message.role : "?";
					const subContent = role === "assistant"
						? (sub.message.content || []).filter(b => b.type === "text").map(b => b.text).join("").slice(0, 200)
						: role === "toolResult"
						? (sub.message.content || []).map(b => b.text).join("").slice(0, 200)
						: "";
					subEl.innerHTML = `<span class="sub-role">${esc(role)}</span><span class="sub-content">${esc(subContent)}</span>`;
					bdy.appendChild(subEl);
				}
			}
		}
	};

	wrap.appendChild(hdr);
	wrap.appendChild(bdy);
	return wrap;
}

function appendToSessionsLive(doc) {
	if (!doc) return;
	sessionLiveDirty = true;
	// Mark dirty — tree reloads on demand when agent finishes
}



function fmtTok(n) {
	return n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

// ── Step / queue controls ──────────────────────────────────────────────────
function renderStepBtn() {
	const btn = document.getElementById("step-btn");
	if (stepEnabled) {
		btn.textContent = "Step \u25cf";
		btn.className = "btn btn-step-toggle on";
	} else {
		btn.textContent = "Step \u25cb";
		btn.className = "btn btn-step-toggle";
	}
}

async function startMission() {
	if (missionStarted) return;
	await fetch("/start", { method: "POST" });
	setStarted(true);
}

async function toggleStep() {
	const r = await fetch("/toggle-step", { method: "POST" });
	const d = await r.json();
	stepEnabled = d.stepEnabled;
	if (!stepEnabled) stepWaiting = false;
	renderStepBtn();
	renderQueue();
}

async function advanceStep() {
	await fetch("/step", { method: "POST" });
}

function renderQueue() {
	const strip = document.getElementById("queue-strip");
	if (!strip) return;
	if (stepEnabled && stepWaiting && runningAgent) {
		let html = `<button class="btn-run" onclick="advanceStep()">\u25b6 Run ${esc(agentDisplayName(runningAgent))}</button>`;
		for (const id of pendingAgents)
			html += `<span class="q-arrow">\u2192</span><span class="q-agent">${esc(agentDisplayName(id))}</span>`;
		strip.innerHTML = html;
		return;
	}
	if (runningAgent) {
		let html = `<span class="q-agent running">${esc(agentDisplayName(runningAgent))}</span>`;
		for (const id of pendingAgents)
			html += `<span class="q-arrow">\u2192</span><span class="q-agent">${esc(agentDisplayName(id))}</span>`;
		strip.innerHTML = html;
		return;
	}
	strip.innerHTML = '<span class="q-idle">Idle \u2014 waiting for messages</span>';
}

function agentDisplayName(id) {
	const a = AGENTS.find(a => a.id === id);
	return a ? a.name : id;
}

function renderAgentTabIndicators() {
	document.querySelectorAll(".agent-tab[data-id]").forEach(tab => {
		const id = tab.dataset.id;
		const nameEl = tab.querySelector(".tab-name");
		if (!nameEl) return;
		const base = tab.dataset.baseName || nameEl.textContent.replace(/^\u25b6\u00a0/, "");
		tab.dataset.baseName = base;
		nameEl.textContent = id === runningAgent ? `\u25b6\u00a0${base}` : base;
	});
	updateScheduleTabs();
}

function stopDaemon() {
	if (stopped) return;
	if (!confirm("Stop the MAGI daemon? This will abort the current mission cycle.")) return;
	fetch("/stop", { method: "POST" }).catch(() => {});
	document.getElementById("stop-btn").disabled = true;
	document.getElementById("stop-btn").textContent = "Stopping\u2026";
}

// ── Compose ────────────────────────────────────────────────────────────────
function openCompose() {
	document.getElementById("compose-overlay").classList.remove("hidden");
	document.getElementById("compose-body").focus();
}

function closeCompose() {
	delete document.getElementById("compose-overlay").dataset.playbookIdx;
	document.getElementById("compose-overlay").classList.add("hidden");
}

function closeComposeIfBg(e) {
	if (e.target === document.getElementById("compose-overlay")) closeCompose();
}

function checkAll() {
	document.querySelectorAll("#to-checks input[type=checkbox]").forEach(c => { c.checked = true; });
}

async function sendMessage() {
	const to = [...document.querySelectorAll("#to-checks input:checked")].map(c => c.value);
	const subject = document.getElementById("compose-subject").value.trim();
	const message = document.getElementById("compose-body").value.trim();
	if (!to.length) { alert("Select at least one recipient"); return; }
	if (!message) { alert("Message body is required"); return; }
	const r = await fetch("/send-message", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to, subject, message }),
	});
	if (r.ok) {
		const idx = document.getElementById("compose-overlay").dataset.playbookIdx;
		if (idx !== undefined) {
			playbookSent.add(Number(idx));
			if (activeAgent === null) renderPlaybook();
		}
		closeCompose();
		document.getElementById("compose-body").value = "";
		document.getElementById("compose-subject").value = "";
		document.querySelectorAll("#to-checks input").forEach(c => { c.checked = false; });
	}
}

// ── Uptime ─────────────────────────────────────────────────────────────────
setInterval(() => {
	const sec = Math.floor((Date.now() - startedAt) / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	document.getElementById("hup").textContent =
		h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}, 1000);

// ── Playbook ───────────────────────────────────────────────────────────────
const playbookSent = new Set();

function selectPlaybook() {
	activeAgent = null;
	document.querySelectorAll(".agent-tab").forEach(t => t.classList.remove("active"));
	document.getElementById("tab-playbook").classList.add("active");
	const pane = resetPane();
	if (!PLAYBOOK.length) {
		pane.innerHTML = '<div class="empty-state">No playbook messages defined</div>';
		return;
	}
	renderPlaybook();
}

function renderPlaybook() {
	const pane = resetPane();
	if (!PLAYBOOK.length) {
		pane.innerHTML = '<div class="empty-state">No playbook messages defined</div>';
		return;
	}
	PLAYBOOK.forEach((entry, i) => {
		const sent = playbookSent.has(i);
		const div = document.createElement("div");
		div.className = `pb-item${sent ? " sent" : ""}`;
		const toHtml = entry.to.map(t => `<span class="ac-${esc(t)}">${esc(t)}</span>`).join(", ");
		div.innerHTML =
			`<div class="pb-title">${esc(entry.title)}</div>` +
			`<div class="pb-meta">To: ${toHtml}</div>` +
			`<div class="pb-preview">${esc(entry.body.slice(0, 200))}${entry.body.length > 200 ? "\u2026" : ""}</div>` +
			`<div class="pb-actions">` +
			`<button class="btn pb-edit" onclick="editPlaybookEntry(${i})">\u270f Edit &amp; Send</button>` +
			(sent ? '<span class="pb-sent-badge">\u2713 sent</span>' : "") +
			'</div>';
		pane.appendChild(div);
	});
}

function editPlaybookEntry(i) {
	const entry = PLAYBOOK[i];
	if (!entry) return;
	document.querySelectorAll("#to-checks input[type=checkbox]").forEach(c => {
		c.checked = entry.to.includes(c.value);
	});
	document.getElementById("compose-subject").value = entry.subject;
	document.getElementById("compose-body").value = entry.body;
	document.getElementById("compose-overlay").dataset.playbookIdx = String(i);
	document.getElementById("compose-overlay").classList.remove("hidden");
	document.getElementById("compose-body").focus();
}

// ── Tool icons ─────────────────────────────────────────────────────────────
function _toolIcon(name) {
	return {
		Bash: "\u2699", WriteFile: "\u270d", EditFile: "\u270f",
		PostMessage: "\u2709", UpdateMentalMap: "\uD83E\uDDE0",
		FetchUrl: "\uD83C\uDF10", BrowseWeb: "\uD83C\uDF10",
		SearchWeb: "\uD83D\uDD0D", InspectImage: "\uD83D\uDDBC",
		ListTeam: "\uD83D\uDC65", ListMessages: "\uD83D\uDCEC",
		ReadMessage: "\uD83D\uDCE8", Research: "\uD83D\uDD2C",
	}[name] || "\uD83D\uDD27";
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	if (isNaN(d)) return "";
	const now = new Date();
	const isToday = d.toDateString() === now.toDateString();
	return isToday
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
		  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Start ──────────────────────────────────────────────────────────────────
init().catch(e => console.error("[app] init failed:", e));
