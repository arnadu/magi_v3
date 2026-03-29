// MAGI Monitor — app.js v2

const CTX_LIMIT = 200_000;

// ── State ──────────────────────────────────────────────────────────────────
let AGENTS = [];
let PLAYBOOK = [];
let activeAgent = null;
let activeSubTab = "mm";     // mm | sessions | usage
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

// Sessions tab state
let sessionConvDocs = [];
let sessionUsageDocs = [];
let selectedTurn = null;
let sessionMode = "summary";  // summary | tools | full
let sessionLiveDirty = false;
const convToolBoxes = new Map();

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
	es.addEventListener("mental-map-update", e => {
		const d = JSON.parse(e.data);
		if (d.agentId === activeAgent && activeSubTab === "mm") renderMentalMap(d.html);
	});
	es.addEventListener("conversation-update", e => {
		const d = JSON.parse(e.data);
		if (d.agentId !== activeAgent) return;
		if (activeSubTab === "sessions") appendToSessionsLive(d.message);
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
		if (!d.running && activeAgent && activeSubTab === "sessions" && sessionLiveDirty) {
			sessionLiveDirty = false;
			loadSessions();
		}
	});
	es.addEventListener("cost-limit", () => {
		document.getElementById("hcost").classList.add("danger");
		addSysMsg("\u26a0 Cost limit reached \u2014 daemon aborting");
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
	convToolBoxes.clear();
	sessionConvDocs = [];
	sessionUsageDocs = [];
	selectedTurn = null;
	sessionLiveDirty = false;
	document.querySelectorAll(".agent-tab").forEach(t =>
		t.classList.toggle("active", t.dataset.id === id));
	document.getElementById("tab-playbook").classList.remove("active");
	document.getElementById("sub-tabs-bar").style.display = "";
	loadDetail();
}

function selectSubTab(tab) {
	activeSubTab = tab;
	document.getElementById("st-mm").classList.toggle("active", tab === "mm");
	document.getElementById("st-sessions").classList.toggle("active", tab === "sessions");
	document.getElementById("st-usage").classList.toggle("active", tab === "usage");
	loadDetail();
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

async function loadDetail() {
	if (!activeAgent) return;
	if (activeSubTab === "mm") {
		const pane = resetPane();
		pane.innerHTML = '<div class="empty-state">Loading\u2026</div>';
		const r = await fetch(`/agents/${activeAgent}/mental-map`);
		const data = await r.json();
		renderMentalMap(data.html);
	} else if (activeSubTab === "sessions") {
		await loadSessions();
	} else if (activeSubTab === "usage") {
		await loadUsage();
	}
}

// ── Mental Map ─────────────────────────────────────────────────────────────
function renderMentalMap(html) {
	const pane = resetPane();
	if (!html) {
		pane.innerHTML = '<div class="empty-state">Mental map is empty</div>';
		return;
	}
	const div = document.createElement("div");
	div.className = "mental-map-html";
	div.innerHTML = html;
	pane.appendChild(div);
}

// ── Sessions tab ───────────────────────────────────────────────────────────
async function loadSessions() {
	const pane = document.getElementById("detail-pane");
	pane.style.padding = "0";
	pane.style.overflow = "hidden";
	pane.style.display = "grid";
	pane.style.gridTemplateColumns = "190px 1fr";
	pane.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Loading\u2026</div>';

	const [convRes, usageRes] = await Promise.all([
		fetch(`/agents/${activeAgent}/conversation`),
		fetch(`/agents/${activeAgent}/usage`),
	]);
	sessionConvDocs = await convRes.json();
	sessionUsageDocs = await usageRes.json();
	renderSessionsLayout();
}

function renderSessionsLayout() {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = "";

	const turnsPanel = document.createElement("div");
	turnsPanel.className = "turns-panel";
	turnsPanel.id = "turns-panel";

	const contentPanel = document.createElement("div");
	contentPanel.className = "turns-content";
	contentPanel.innerHTML =
		'<div class="turns-mode-bar" id="turns-mode-bar">' +
		'<button class="mode-btn active" data-mode="summary" onclick="setSessionMode(\'summary\')">Summary</button>' +
		'<button class="mode-btn" data-mode="tools" onclick="setSessionMode(\'tools\')">Tools</button>' +
		'<button class="mode-btn" data-mode="full" onclick="setSessionMode(\'full\')">Full</button>' +
		'</div>' +
		'<div class="turns-body" id="turns-body"><div class="empty-state">Select a session</div></div>';

	pane.appendChild(turnsPanel);
	pane.appendChild(contentPanel);

	const turns = buildTurnList();
	renderTurnList(turns, turnsPanel);

	if (turns.length) {
		const latest = [...turns].reverse().find(t => !t.allReflection) || turns.at(-1);
		if (latest) selectTurn(latest.turnNumber);
	}
}

function buildTurnList() {
	const convByTurn = new Map();
	for (const doc of sessionConvDocs) {
		const n = doc.turnNumber ?? 0;
		if (!convByTurn.has(n)) convByTurn.set(n, []);
		convByTurn.get(n).push(doc);
	}
	const usageByTurn = new Map();
	for (const d of sessionUsageDocs) {
		const n = d.turnNumber ?? 0;
		if (!usageByTurn.has(n)) usageByTurn.set(n, []);
		usageByTurn.get(n).push(d);
	}
	const allTurns = new Set([...convByTurn.keys(), ...usageByTurn.keys()]);
	const turns = [];
	for (const n of [...allTurns].sort((a, b) => a - b)) {
		const convDocs = convByTurn.get(n) || [];
		const usageDocs = usageByTurn.get(n) || [];
		let toolCalls = 0;
		let timestamp = null;
		for (const doc of convDocs) {
			const m = doc.message;
			if (!m) continue;
			if (m.role === "assistant")
				toolCalls += (m.content || []).filter(b => b.type === "toolCall").length;
			if (!timestamp && m.timestamp) timestamp = m.timestamp;
		}
		let peakInput = 0, costUsd = 0, llmCalls = 0;
		let hasReflection = false;
		for (const u of usageDocs) {
			llmCalls++;
			if (u.isReflection) hasReflection = true;
			if (u.usage) {
				peakInput = Math.max(peakInput, u.usage.inputTokens || 0);
				costUsd += u.usage.cost || 0;
			}
		}
		const allReflection = usageDocs.length > 0 && usageDocs.every(u => u.isReflection);
		turns.push({ turnNumber: n, toolCalls, llmCalls, peakInput, costUsd, timestamp, hasReflection, allReflection });
	}
	return turns;
}

function renderTurnList(turns, container) {
	container.innerHTML = "";
	if (!turns.length) {
		container.innerHTML = '<div class="empty-state">No sessions yet</div>';
		return;
	}
	for (const t of turns) {
		const div = document.createElement("div");
		div.className = `turn-item${t.allReflection ? " turn-reflection" : ""}`;
		div.dataset.turn = t.turnNumber;
		div.onclick = () => selectTurn(t.turnNumber);
		const reflBadge = t.hasReflection ? '<span class="turn-reflect-badge" title="Reflection ran this session">\u21ba</span>' : "";
		const tokStr = t.peakInput > 0 ? `${Math.round(t.peakInput / 1000)}k ctx` : "";
		const costStr = t.costUsd > 0 ? `$${t.costUsd.toFixed(3)}` : "";
		const timeLabel = t.timestamp ? fmtTime(t.timestamp) : `Session ${t.turnNumber}`;
		div.innerHTML =
			`<div class="turn-num">${esc(timeLabel)}${reflBadge}</div>` +
			`<div class="turn-stats">` +
			(t.llmCalls > 0 ? `<span>${t.llmCalls} LLM calls</span>` : "") +
			(tokStr ? `<span>${tokStr}</span>` : "") +
			(costStr ? `<span class="turn-cost">${costStr}</span>` : "") +
			`</div>` +
			(!t.timestamp ? "" : `<div class="turn-seq">session ${t.turnNumber}</div>`);
		container.appendChild(div);
	}
}

function selectTurn(n) {
	selectedTurn = n;
	document.querySelectorAll(".turn-item").forEach(el =>
		el.classList.toggle("active", Number(el.dataset.turn) === n));
	renderTurnContent();
}

function setSessionMode(mode) {
	sessionMode = mode;
	document.querySelectorAll(".mode-btn").forEach(b =>
		b.classList.toggle("active", b.dataset.mode === mode));
	renderTurnContent();
}

function renderTurnContent() {
	const body = document.getElementById("turns-body");
	if (!body) return;
	if (selectedTurn === null) {
		body.innerHTML = '<div class="empty-state">Select a session on the left</div>';
		return;
	}
	const docs = sessionConvDocs.filter(d => (d.turnNumber ?? 0) === selectedTurn);
	if (!docs.length) {
		body.innerHTML = '<div class="empty-state">No messages for this session</div>';
		return;
	}
	body.innerHTML = "";
	convToolBoxes.clear();
	if (sessionMode === "summary") renderTurnSummary(docs, body);
	else if (sessionMode === "tools") renderTurnTools(docs, body);
	else renderTurnFull(docs, body);
	body.scrollTop = 0;
}

function renderTurnSummary(docs, container) {
	let any = false;
	for (const doc of docs) {
		const m = doc.message;
		if (!m) continue;
		if (m.role === "assistant") {
			const blocks = Array.isArray(m.content) ? m.content : [];
			for (const b of blocks.filter(b => b.type === "text" && b.text?.trim())) {
				const el = document.createElement("div");
				el.className = "sum-text";
				el.textContent = b.text.trim();
				container.appendChild(el);
				any = true;
			}
			for (const call of blocks.filter(b => b.type === "toolCall" && b.name === "PostMessage")) {
				const args = call.arguments || {};
				const to = Array.isArray(args.to) ? args.to.join(", ") : args.to || "?";
				const el = document.createElement("div");
				el.className = "sum-pm";
				el.innerHTML =
					`<span class="sum-pm-icon">\u2709</span>` +
					`<span class="sum-pm-to">\u2192 ${esc(to)}</span>` +
					(args.subject ? `<span class="sum-pm-subj">${esc(String(args.subject).slice(0, 80))}</span>` : "") +
					(args.message ? `<div class="sum-pm-body">${esc(String(args.message).slice(0, 300))}</div>` : "");
				container.appendChild(el);
				any = true;
			}
		} else if (m.role === "toolResult" && m.isError) {
			const txt = (m.content || []).map(b => b.text).join("").slice(0, 200);
			const el = document.createElement("div");
			el.className = "sum-error";
			el.textContent = `\u2717 ${m.toolName || "?"}: ${txt}`;
			container.appendChild(el);
			any = true;
		}
	}
	if (!any) container.innerHTML = '<div class="empty-state">Nothing notable in this session</div>';
}

function renderTurnTools(docs, container) {
	const pending = new Map();
	let any = false;
	for (const doc of docs) {
		const m = doc.message;
		if (!m) continue;
		if (m.role === "assistant") {
			for (const block of (m.content || []).filter(b => b.type === "toolCall")) {
				const firstKey = Object.keys(block.arguments || {})[0];
				const firstVal = firstKey ? String(block.arguments[firstKey]).slice(0, 60) : "";
				const el = document.createElement("div");
				el.className = "tool-row";
				el.innerHTML =
					`<span class="tool-row-icon">${_toolIcon(block.name)}</span>` +
					`<span class="tool-row-name">${esc(block.name)}</span>` +
					(firstVal ? `<span class="tool-row-arg">${esc(firstVal)}</span>` : "") +
					`<span class="tool-row-status pending">\u2026</span>`;
				container.appendChild(el);
				pending.set(block.id, el.querySelector(".tool-row-status"));
				any = true;
			}
		} else if (m.role === "toolResult") {
			const slot = pending.get(m.toolCallId);
			if (slot) {
				slot.textContent = m.isError ? "\u2717" : "\u2713";
				slot.className = `tool-row-status ${m.isError ? "err" : "ok"}`;
				pending.delete(m.toolCallId);
			}
		}
	}
	if (!any) container.innerHTML = '<div class="empty-state">No tool calls in this session</div>';
}

function renderTurnFull(docs, container) {
	convToolBoxes.clear();
	for (const doc of docs) _renderFullDoc(doc, container);
}

function _renderFullDoc(doc, pane) {
	const m = doc.message;
	if (!m) return;
	const agentId = doc.agentId ?? activeAgent ?? "";

	if (m.role === "user") {
		const content = typeof m.content === "string" ? m.content
			: (m.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
		const el = document.createElement("div");
		el.className = "conv-bubble conv-bubble-user";
		el.innerHTML =
			'<div class="conv-avatar av-user">\uD83D\uDCE8</div>' +
			'<div class="conv-body">' +
			'<div class="conv-label">Operator / Mailbox</div>' +
			`<div class="conv-text">${esc(content)}</div>` +
			'</div>';
		pane.appendChild(el);
	} else if (m.role === "assistant") {
		const blocks = Array.isArray(m.content) ? m.content : [];
		const thinking = blocks.filter(b => b.type === "thinking" && b.thinking?.trim());
		const texts = blocks.filter(b => b.type === "text" && b.text?.trim());
		const calls = blocks.filter(b => b.type === "toolCall");
		if (thinking.length) {
			const full = thinking.map(b => b.thinking).join("\n\n");
			const el = document.createElement("div");
			el.className = "conv-bubble";
			el.innerHTML =
				'<div class="conv-avatar av-think">\uD83D\uDCAD</div>' +
				'<div class="conv-body"><div class="conv-label">Thinking</div>' +
				`<div class="conv-text conv-think-text">${esc(full.slice(0, 600))}${full.length > 600 ? "\u2026" : ""}</div>` +
				'</div>';
			pane.appendChild(el);
		}
		if (texts.length) {
			const el = document.createElement("div");
			el.className = "conv-bubble conv-bubble-agent";
			el.innerHTML =
				'<div class="conv-avatar av-agent">AI</div>' +
				'<div class="conv-body">' +
				`<div class="conv-text">${esc(texts.map(b => b.text).join("\n\n"))}</div>` +
				'</div>';
			pane.appendChild(el);
		}
		for (const call of calls) {
			const box = _makeToolBox(call.name, call.arguments);
			pane.appendChild(box.el);
			convToolBoxes.set(`${agentId}:${call.id}`, box.resultEl);
		}
	} else if (m.role === "toolResult") {
		const slot = convToolBoxes.get(`${agentId}:${m.toolCallId}`);
		if (slot) {
			_fillResult(slot, m);
		} else {
			const txt = (m.content || []).filter(b => b.type === "text").map(b => b.text).join("").slice(0, 500);
			const el = document.createElement("div");
			el.className = "conv-tool-box";
			el.innerHTML =
				`<div class="conv-tool-hdr" onclick="toggleToolBox(this)">` +
				`<span class="conv-tool-icon">${_toolIcon(m.toolName)}</span>` +
				`<span class="conv-tool-name">${esc(m.toolName)}</span>` +
				'<span class="conv-tool-arrow">\u25b6</span>' +
				'</div>' +
				'<div class="conv-tool-body">' +
				`<div class="conv-tool-result ${m.isError ? "err" : "ok"}">${esc(txt)}</div>` +
				'</div>';
			pane.appendChild(el);
		}
	}
}

function _makeToolBox(name, args) {
	const el = document.createElement("div");
	el.className = "conv-tool-box";
	const argsStr = JSON.stringify(args, null, 2);
	// Collapsed by default — no "open" class on conv-tool-body
	el.innerHTML =
		`<div class="conv-tool-hdr" onclick="toggleToolBox(this)">` +
		`<span class="conv-tool-icon">${_toolIcon(name)}</span>` +
		`<span class="conv-tool-name">${esc(name)}</span>` +
		'<span class="conv-tool-arrow">\u25b6</span>' +
		'</div>' +
		'<div class="conv-tool-body">' +
		`<div class="conv-tool-args">${esc(argsStr)}</div>` +
		'<div class="conv-tool-result pending">\u23f3 running\u2026</div>' +
		'</div>';
	return { el, resultEl: el.querySelector(".conv-tool-result") };
}

function _fillResult(el, m) {
	const txt = (m.content || []).filter(b => b.type === "text").map(b => b.text).join("");
	el.className = `conv-tool-result ${m.isError ? "err" : "ok"}`;
	el.textContent = txt.slice(0, 1000) + (txt.length > 1000 ? "\u2026" : "");
}

function toggleToolBox(hdr) {
	const body = hdr.nextElementSibling;
	const arrow = hdr.querySelector(".conv-tool-arrow");
	const open = body.classList.toggle("open");
	arrow.textContent = open ? "\u25bc" : "\u25b6";
}

function appendToSessionsLive(doc) {
	if (!doc) return;
	sessionLiveDirty = true;
	const n = doc.turnNumber ?? 0;
	sessionConvDocs.push(doc);
	// Ensure turn entry exists in list
	const panel = document.getElementById("turns-panel");
	if (panel && !panel.querySelector(`[data-turn="${n}"]`)) {
		const div = document.createElement("div");
		div.className = "turn-item";
		div.dataset.turn = n;
		div.onclick = () => selectTurn(n);
		div.innerHTML = `<div class="turn-num">Session ${n} <span style="color:var(--green);font-size:9px">● live</span></div>`;
		panel.appendChild(div);
	}
	// If this turn is selected (or nothing selected yet), append to content
	if (selectedTurn === null || selectedTurn === n) {
		if (selectedTurn === null) {
			selectedTurn = n;
			document.querySelectorAll(".turn-item").forEach(el =>
				el.classList.toggle("active", Number(el.dataset.turn) === n));
		}
		const body = document.getElementById("turns-body");
		if (body && sessionMode === "full") {
			body.querySelector(".empty-state")?.remove();
			_renderFullDoc(doc, body);
			body.scrollTop = body.scrollHeight;
		}
	}
}

// ── Usage tab ──────────────────────────────────────────────────────────────
async function loadUsage() {
	const pane = resetPane();
	pane.innerHTML = '<div class="empty-state">Loading\u2026</div>';
	const r = await fetch(`/agents/${activeAgent}/usage`);
	sessionUsageDocs = await r.json();
	renderUsageChart(sessionUsageDocs);
}

function renderUsageChart(docs) {
	const pane = document.getElementById("detail-pane");
	if (!pane) return;
	if (!docs.length) {
		pane.innerHTML = '<div class="empty-state">No LLM call data yet</div>';
		return;
	}
	const maxTokens = Math.max(CTX_LIMIT,
		...docs.map(d => d.usage?.inputTokens || 0));

	pane.innerHTML =
		'<div class="usage-chart">' +
		'<div class="uc-legend">' +
		'<span class="uc-leg fresh">fresh input</span>' +
		'<span class="uc-leg cache">cache read</span>' +
		'<span class="uc-leg output">output</span>' +
		'</div>' +
		'<div class="uc-rows" id="uc-rows"></div>' +
		'</div>';

	const rows = document.getElementById("uc-rows");
	for (const d of docs) {
		const u = d.usage || {};
		const input = u.inputTokens || 0;
		const cacheRead = u.cacheReadTokens || 0;
		const output = u.outputTokens || 0;
		const freshInput = Math.max(0, input - cacheRead);
		const cost = u.cost || 0;
		const freshPct = (freshInput / maxTokens * 100).toFixed(1);
		const cachePct = (cacheRead / maxTokens * 100).toFixed(1);
		const outPct = (output / maxTokens * 100).toFixed(1);
		const ctxPct = input > 0 ? (input / CTX_LIMIT * 100).toFixed(0) : "0";
		const ctxLimitPct = (CTX_LIMIT / maxTokens * 100).toFixed(1);
		const row = document.createElement("div");
		row.className = `uc-row${d.isReflection ? " uc-reflection" : ""}`;
		row.innerHTML =
			`<div class="uc-label" title="Session ${d.turnNumber ?? 0}">S${d.turnNumber ?? 0}${d.isReflection ? "\u21ba" : ""}</div>` +
			`<div class="uc-bar-wrap">` +
			`<div class="uc-bar">` +
			`<div class="uc-seg fresh" style="width:${freshPct}%" title="fresh input: ${fmtTok(freshInput)}"></div>` +
			`<div class="uc-seg cache" style="width:${cachePct}%" title="cache read: ${fmtTok(cacheRead)}"></div>` +
			`<div class="uc-seg output" style="width:${outPct}%" title="output: ${fmtTok(output)}"></div>` +
			`<div class="uc-ctx-line" style="left:${ctxLimitPct}%" title="200k ctx limit"></div>` +
			`</div>` +
			`</div>` +
			`<div class="uc-stats">` +
			`<span title="${input} input tokens">${fmtTok(input)}</span>` +
			`<span class="uc-ctx-pct${Number(ctxPct) > 80 ? " warn" : ""}">${ctxPct}%</span>` +
			(cost > 0 ? `<span class="uc-cost">$${cost.toFixed(4)}</span>` : "") +
			`</div>`;
		rows.appendChild(row);
	}

	const totalInput = docs.reduce((s, d) => s + (d.usage?.inputTokens || 0), 0);
	const totalOutput = docs.reduce((s, d) => s + (d.usage?.outputTokens || 0), 0);
	const totalCost = docs.reduce((s, d) => s + (d.usage?.cost || 0), 0);
	const tot = document.createElement("div");
	tot.className = "uc-total";
	tot.innerHTML =
		`<span>${docs.length} LLM calls</span>` +
		`<span>${fmtTok(totalInput)} total input</span>` +
		`<span>${fmtTok(totalOutput)} total output</span>` +
		`<span class="uc-cost">$${totalCost.toFixed(4)}</span>`;
	rows.appendChild(tot);
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
	document.getElementById("sub-tabs-bar").style.display = "none";
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
