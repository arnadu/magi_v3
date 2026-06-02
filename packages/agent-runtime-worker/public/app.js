// MAGI Monitor — app.js v3 (Sprint 18)

const CTX_LIMIT = 200_000;

// ── State ──────────────────────────────────────────────────────────────────
let AGENTS = [];
let activeAgent = null; // null = Mission tab
let activeTab = null; // "activity"|"mentalmap"|"files"|"schedule"|"log"|"stats"
let activeThread = null; // threadKey of selected thread

const agentContextTokens = {};
const agentCosts = {};
let stepEnabled = false;
let stepWaiting = false;
let runningAgents = new Set();
let startedAt = Date.now();
let maxCostUsd = null;
let stopped = false;

const allMessages = [];
const threads = new Map(); // threadKey → { subject, messages[], participants Set }
let scheduleData = [];

// Unread tracking (persisted to localStorage)
const seenAt = new Map(); // threadKey → Date

// Session tree state
let sessionLiveDirty = false;
const expandedSessions = new Set();

// File browser state
let filePath = "";
let fileBrowserType = "shared";
let fileBrowserAgentId = null;

// Compose recipients
let composeRecipients = [];

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
	loadSeenState();

	const [teamRes, statusRes, mailboxRes, scheduleRes] = await Promise.all([
		fetch("team"),
		fetch("status"),
		fetch("mailbox"),
		fetch("schedule"),
	]);

	AGENTS = await teamRes.json();
	const status = await statusRes.json();
	const history = await mailboxRes.json();
	scheduleData = await scheduleRes.json();

	injectAgentColors(AGENTS);
	populateAgentTabs(AGENTS);
	renderRecipientChips();
	applyStatus(status);

	for (const m of history) allMessages.push(m);
	buildThreads();
	renderThreadList();

	selectMissionTab();

	setInterval(refreshSchedule, 60_000);
	setInterval(updateUptime, 1000);
	connectSSE();
}

function loadSeenState() {
	try {
		const raw = localStorage.getItem("magi-seen-threads");
		if (raw) {
			const obj = JSON.parse(raw);
			for (const [k, v] of Object.entries(obj)) seenAt.set(k, new Date(v));
		}
	} catch {}
}

function persistSeen() {
	try {
		const obj = {};
		for (const [k, v] of seenAt.entries()) obj[k] = v.toISOString();
		localStorage.setItem("magi-seen-threads", JSON.stringify(obj));
	} catch {}
}

// ── Agent tabs ─────────────────────────────────────────────────────────────
function populateAgentTabs(agents) {
	const bar = document.getElementById("agent-tabs");
	bar.innerHTML = "";

	agents.forEach((a) => {
		const tab = document.createElement("div");
		tab.className = "agent-tab";
		tab.dataset.id = a.id;
		tab.innerHTML =
			`<div class="tab-name">${esc(a.name)}</div>` +
			`<div class="tab-role">${esc(a.role)}</div>` +
			`<div class="tab-ctx">` +
			`<span class="tab-ctx-label">—</span>` +
			`<div class="tab-ctx-bar"><div class="tab-ctx-fill"></div></div>` +
			`</div>`;
		tab.onclick = () => selectAgent(a.id);
		bar.appendChild(tab);
	});

	const missionTab = document.createElement("div");
	missionTab.className = "agent-tab mission-tab";
	missionTab.id = "tab-mission";
	missionTab.innerHTML =
		`<div class="tab-name">Mission</div>` +
		`<div class="tab-role">overview</div>`;
	missionTab.onclick = selectMissionTab;
	bar.appendChild(missionTab);
}

function injectAgentColors(agents) {
	const COLORS = ["--c0", "--c1", "--c2", "--c3", "--c4"];
	const lines = agents.map((a, i) => {
		const safe = a.id.replace(/-/g, "\\-");
		const color = `var(${COLORS[i] || "--muted"})`;
		return `.ac-${safe}{color:${color}} .ab-${safe}{border-left-color:${color}}`;
	});
	lines.push(
		".ac-scheduler{color:var(--c-sched)} .ab-scheduler{border-left-color:var(--c-sched)}",
	);
	lines.push(
		".ac-user{color:var(--c-user)} .ab-user{border-left-color:var(--c-user)}",
	);
	const style = document.createElement("style");
	style.textContent = lines.join("\n");
	document.head.appendChild(style);
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
	const es = new EventSource("events");
	es.onopen = () => document.getElementById("dot").classList.remove("dead");
	es.onerror = () => document.getElementById("dot").classList.add("dead");

	es.addEventListener("status", (e) => applyStatus(JSON.parse(e.data)));

	es.addEventListener("mailbox-msg", (e) => {
		const m = JSON.parse(e.data);
		allMessages.push(m);
		buildThreads();
		renderThreadList();
		if (activeThread === threadKey(m)) renderChatView();
	});

	es.addEventListener("llm-call", (e) => {
		const d = JSON.parse(e.data);
		updateCostDisplay(d.missionTotalUsd, maxCostUsd);
		agentCosts[d.agentId] = d.agentTotalUsd;
		agentContextTokens[d.agentId] = d.input;
		updateContextBar(d.agentId, d.input);
		if (activeTab === "stats" && activeAgent === null) renderStats();
	});

	es.addEventListener("step-paused", () => {
		stepWaiting = true;
		renderStepBtn();
	});

	es.addEventListener("step-resumed", () => {
		stepWaiting = false;
		renderStepBtn();
	});

	es.addEventListener("conversation-update", (e) => {
		const d = JSON.parse(e.data);
		if (d.agentId === activeAgent && activeTab === "activity") {
			sessionLiveDirty = true;
		}
	});

	es.addEventListener("mental-map-update", () => {
		if (activeAgent && activeTab === "mentalmap") loadMentalMap();
	});

	es.addEventListener("agent-status", (e) => {
		const d = JSON.parse(e.data);
		const wasRunning = new Set(runningAgents);
		runningAgents = new Set(d.running || []);
		renderAgentTabIndicators();
		if (
			activeAgent &&
			activeTab === "activity" &&
			sessionLiveDirty &&
			wasRunning.has(activeAgent) &&
			!runningAgents.has(activeAgent)
		) {
			sessionLiveDirty = false;
			loadSessions();
		}
	});

	es.addEventListener("agent-error", (e) => {
		const d = JSON.parse(e.data);
		showAgentErrorBanner(d.agentId, d.errorMessage, d.transient);
	});

	es.addEventListener("cost-pause", (e) => {
		const d = JSON.parse(e.data);
		showBudgetBanner(d.spentUsd, d.capUsd);
	});

	es.addEventListener("cost-resumed", (e) => {
		const d = JSON.parse(e.data);
		hideBudgetBanner();
		maxCostUsd = d.newCapUsd ?? maxCostUsd;
	});

	es.addEventListener("shutdown", () => {
		document.getElementById("dot").classList.add("dead");
		const btn = document.getElementById("kill-btn");
		if (btn) {
			btn.disabled = true;
			btn.textContent = "— stopped";
		}
		stopped = true;
	});
}

// ── Status ─────────────────────────────────────────────────────────────────
function applyStatus(s) {
	document.getElementById("hname").textContent = s.missionName || s.missionId;
	document.getElementById("hmeta").textContent = s.model;
	startedAt = Date.now() - s.uptimeSec * 1000;
	maxCostUsd = s.maxCostUsd;
	stepEnabled = s.stepEnabled;
	runningAgents = new Set(s.running || []);

	if (s.budgetPaused) showBudgetBanner(s.missionTotalUsd, s.maxCostUsd);
	else hideBudgetBanner();
	renderStepBtn();
	renderAgentTabIndicators();
	updateCostDisplay(s.missionTotalUsd ?? 0, s.maxCostUsd);
	if (s.agents) {
		for (const a of s.agents) {
			agentCosts[a.agentId] = a.costUsd;
			if (a.input) {
				agentContextTokens[a.agentId] = a.input;
				updateContextBar(a.agentId, a.input);
			}
		}
	}
}

function updateCostDisplay(total, max) {
	const el = document.getElementById("hcost");
	if (!el) return;
	el.textContent = `$${(total ?? 0).toFixed(4)}`;
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
	label.textContent =
		tokens >= 1000 ? `${(tokens / 1000).toFixed(0)}k` : String(tokens);
	fill.style.width = `${pct}%`;
	fill.style.background =
		pct > 80 ? "var(--red)" : pct > 60 ? "var(--yellow)" : "var(--green)";
	tab.classList.toggle("ctx-warn", pct > 75);
}

function renderAgentTabIndicators() {
	document.querySelectorAll(".agent-tab[data-id]").forEach((tab) => {
		tab.classList.toggle("running", runningAgents.has(tab.dataset.id));
	});
}

// ── Budget pause banner ────────────────────────────────────────────────────
function showBudgetBanner(spentUsd, capUsd) {
	const banner = document.getElementById("budget-banner");
	const msg = document.getElementById("budget-msg");
	if (!banner || !msg) return;
	msg.textContent = `Spending cap of $${capUsd?.toFixed(2) ?? "?"} reached ($${spentUsd?.toFixed(4) ?? "?"} spent) — mission paused`;
	banner.classList.remove("hidden");
	document.getElementById("hcost")?.classList.add("danger");
}

function hideBudgetBanner() {
	document.getElementById("budget-banner")?.classList.add("hidden");
	document.getElementById("hcost")?.classList.remove("danger");
	const btn = document.getElementById("extend-btn");
	if (btn) {
		btn.disabled = false;
		btn.textContent = "+$5 and continue";
	}
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function extendBudget() {
	const btn = document.getElementById("extend-btn");
	if (btn) {
		btn.disabled = true;
		btn.textContent = "Extending…";
	}
	try {
		const r = await fetch("extend-budget", { method: "POST" });
		if (!r.ok && btn) {
			btn.disabled = false;
			btn.textContent = "+$5 and continue";
		}
	} catch {
		if (btn) {
			btn.disabled = false;
			btn.textContent = "+$5 and continue";
		}
	}
}

// ── Agent error banner ─────────────────────────────────────────────────────
function showAgentErrorBanner(agentId, errorMessage, transient) {
	const banner = document.getElementById("agent-error-banner");
	const msg = document.getElementById("ae-msg");
	const hint = document.getElementById("ae-hint");
	const resumeBtn = document.getElementById("ae-resume-btn");
	if (!banner || !msg) return;
	const short =
		errorMessage.length > 120 ? `${errorMessage.slice(0, 120)}…` : errorMessage;
	msg.textContent = `Agent ${agentId} stopped — ${short}`;
	if (transient) {
		if (hint)
			hint.textContent =
				"Transient error (rate limit / overload) — the agent will retry automatically on the next wakeup.";
		resumeBtn?.classList.add("hidden");
	} else {
		if (hint)
			hint.textContent =
				"Provider error (credit exhaustion or auth failure) — resolve the issue then click Resume.";
		if (resumeBtn) {
			resumeBtn.classList.remove("hidden");
			resumeBtn.onclick = () => resumeAgentAfterError(agentId);
		}
	}
	banner.classList.remove("hidden");
}

function hideAgentErrorBanner() {
	document.getElementById("agent-error-banner")?.classList.add("hidden");
}

async function resumeAgentAfterError(agentId) {
	const btn = document.getElementById("ae-resume-btn");
	if (btn) {
		btn.disabled = true;
		btn.textContent = "Sending…";
	}
	try {
		await fetch("send-message", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				to: [agentId],
				subject: "Resume after technical interruption",
				message:
					"A technical issue (LLM provider error) interrupted your previous session. The issue has been resolved. Review your mental map to recall where you were, then continue your work.",
			}),
		});
		hideAgentErrorBanner();
	} catch {
		if (btn) {
			btn.disabled = false;
			btn.textContent = "Resume";
		}
	}
}

// ── Thread list + chat view ────────────────────────────────────────────────
// Thread key is the sorted, pipe-joined set of participants — all messages
// between the same people go in one thread regardless of subject.
function threadKey(msg) {
	const parts = new Set([msg.from, ...(msg.to || [])]);
	return [...parts].sort().join("|");
}

function buildThreads() {
	threads.clear();
	for (const m of allMessages) {
		const key = threadKey(m);
		if (!threads.has(key)) {
			threads.set(key, {
				subject: m.subject || "(no subject)",
				messages: [],
				participants: new Set(),
			});
		}
		const t = threads.get(key);
		t.messages.push(m);
		t.participants.add(m.from);
		for (const r of m.to || []) t.participants.add(r);
	}
}

function threadUnreadCount(key) {
	const t = threads.get(key);
	if (!t) return 0;
	const seen = seenAt.get(key);
	if (!seen) return t.messages.length;
	return t.messages.filter((m) => new Date(m.timestamp) > seen).length;
}

function renderThreadList() {
	const list = document.getElementById("thread-list");
	if (!threads.size) {
		list.innerHTML = '<div class="empty-state">Waiting for messages…</div>';
		return;
	}
	const sorted = [...threads.entries()].sort((a, b) => {
		const aLast = new Date(a[1].messages.at(-1)?.timestamp ?? 0);
		const bLast = new Date(b[1].messages.at(-1)?.timestamp ?? 0);
		return bLast - aLast;
	});
	list.innerHTML = "";
	for (const [key, t] of sorted) {
		const unread = threadUnreadCount(key);
		const last = t.messages.at(-1);
		const participants = [...t.participants]
			.filter((p) => p !== "user")
			.join(", ");
		const row = document.createElement("div");
		row.className = `thread-row${unread > 0 ? " unread" : ""}${activeThread === key ? " selected" : ""}`;
		row.onclick = () => openThread(key);
		row.innerHTML =
			`<span class="tr-dot"></span>` +
			`<div class="tr-body">` +
			`<div class="tr-subject">${esc(t.subject)}</div>` +
			`<div class="tr-meta">${esc(participants || "(system)")} · ${fmtTime(last?.timestamp)} · ${t.messages.length}</div>` +
			`</div>`;
		list.appendChild(row);
	}
}

function openThread(key) {
	activeThread = key;
	seenAt.set(key, new Date());
	persistSeen();
	renderThreadList();
	renderChatView();
	const t = threads.get(key);
	if (t) {
		const recipients = [...t.participants].filter((p) => p !== "user");
		setComposeRecipients(recipients);
	}
}

function renderChatView() {
	const view = document.getElementById("chat-view");
	if (!activeThread) {
		view.innerHTML = '<div class="empty-state">Select a thread</div>';
		return;
	}
	const t = threads.get(activeThread);
	if (!t) {
		view.innerHTML = '<div class="empty-state">Thread not found</div>';
		return;
	}
	view.innerHTML = "";
	for (const m of t.messages) {
		const bubble = document.createElement("div");
		bubble.className = `bubble ab-${m.from}`;
		bubble.innerHTML =
			`<div class="bubble-hdr">` +
			`<span class="bubble-from ac-${m.from}">${esc(m.from)}</span>` +
			`<span class="bubble-to">→ ${esc((m.to || []).join(", "))}</span>` +
			`<span class="bubble-time">${fmtTime(m.timestamp)}</span>` +
			`</div>` +
			`<div class="bubble-subject">${esc(m.subject || "")}</div>` +
			`<div class="bubble-body">${md(m.body || "")}</div>`;
		view.appendChild(bubble);
	}
	view.scrollTop = view.scrollHeight;
}

// ── Markdown renderer ──────────────────────────────────────────────────────
function md(text) {
	if (!text) return "";
	// Escape HTML
	let s = String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// Fenced code blocks (must come before inline code)
	s = s.replace(
		/```[^\n]*\n([\s\S]*?)```/g,
		(_, code) => `<pre><code>${code.trimEnd()}</code></pre>`,
	);

	// Inline code
	s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");

	// Headers
	s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
	s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
	s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");

	// Bold and italic
	s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");

	// Links
	s = s.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener">$1</a>',
	);

	// Bullet lists (consecutive lines starting with - or *)
	s = s.replace(/((?:^[ \t]*[-*] .+(?:\n|$))+)/gm, (block) => {
		const items = block
			.trim()
			.split(/\n/)
			.map((line) => `<li>${line.replace(/^[ \t]*[-*] /, "")}</li>`)
			.join("");
		return `<ul>${items}</ul>`;
	});

	// Paragraphs (double newlines become paragraph breaks)
	s = s
		.split(/\n\n+/)
		.map((para) => {
			const trimmed = para.trim();
			if (!trimmed) return "";
			// Don't wrap block-level elements
			if (/^<(?:h[123]|pre|ul|ol|li)/.test(trimmed)) return trimmed;
			return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
		})
		.filter(Boolean)
		.join("");

	return s;
}

// ── Compose bar ────────────────────────────────────────────────────────────
function setComposeRecipients(ids) {
	composeRecipients = [...new Set(ids)];
	renderRecipientChips();
}

function toggleRecipient(id) {
	if (composeRecipients.includes(id)) {
		composeRecipients = composeRecipients.filter((r) => r !== id);
	} else {
		composeRecipients.push(id);
	}
	renderRecipientChips();
}

function renderRecipientChips() {
	const box = document.getElementById("compose-recipients");
	if (!box) return;
	box.innerHTML = "";
	AGENTS.forEach((a) => {
		const chip = document.createElement("span");
		chip.className = `recipient-chip${composeRecipients.includes(a.id) ? " selected" : ""}`;
		chip.textContent = a.name;
		chip.onclick = () => toggleRecipient(a.id);
		box.appendChild(chip);
	});
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
function openCompose(recipientId) {
	if (recipientId) setComposeRecipients([recipientId]);
	document.getElementById("compose-body")?.focus();
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function sendMessage() {
	const to = composeRecipients;
	const message = document.getElementById("compose-body")?.value.trim() ?? "";
	if (!to.length) {
		alert("Select at least one recipient");
		return;
	}
	if (!message) {
		alert("Message body is required");
		return;
	}
	// Set activeThread before the fetch so the SSE that arrives during the
	// round-trip (Change Stream fires before the HTTP response resolves) already
	// finds the correct activeThread and calls renderChatView().
	activeThread = [...new Set(["user", ...to])].sort().join("|");
	const r = await fetch("send-message", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to, subject: "Operator message", message }),
	});
	if (r.ok) {
		const textarea = document.getElementById("compose-body");
		if (textarea) textarea.value = "";
	}
}

// ── Right panel tab routing ────────────────────────────────────────────────
function selectAgent(id) {
	activeAgent = id;
	sessionLiveDirty = false;
	filePath = "";
	document.querySelectorAll(".agent-tab").forEach((t) => {
		t.classList.toggle("active", t.dataset.id === id);
	});
	showTab("activity");
}

function selectMissionTab() {
	activeAgent = null;
	filePath = "";
	document.querySelectorAll(".agent-tab").forEach((t) => {
		t.classList.remove("active");
	});
	document.getElementById("tab-mission")?.classList.add("active");
	showTab("schedule");
}

function showTab(tab) {
	activeTab = tab;
	renderContentTabs();
	loadTabContent();
}

function renderContentTabs() {
	const bar = document.getElementById("content-tabs");
	if (!bar) return;
	const tabs =
		activeAgent === null
			? ["schedule", "files", "log", "stats"]
			: ["activity", "mentalmap", "files"];
	bar.innerHTML = tabs
		.map(
			(t) =>
				`<div class="content-tab${activeTab === t ? " active" : ""}" onclick="showTab('${t}')">${tabLabel(t)}</div>`,
		)
		.join("");
}

function tabLabel(t) {
	return (
		{
			activity: "Activity",
			mentalmap: "Mental Map",
			files: "Files",
			schedule: "Schedule",
			log: "Log",
			stats: "Stats",
		}[t] || t
	);
}

function loadTabContent() {
	switch (activeTab) {
		case "activity":
			loadSessions();
			break;
		case "mentalmap":
			loadMentalMap();
			break;
		case "files":
			loadFiles(activeAgent ? "workdir" : "shared", activeAgent);
			break;
		case "schedule":
			loadSchedule();
			break;
		case "log":
			loadLog();
			break;
		case "stats":
			renderStats();
			break;
	}
}

// ── Activity tab — sessions tree ───────────────────────────────────────────
async function loadSessions() {
	if (!activeAgent) return;
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = '<div class="empty-state">Loading…</div>';
	try {
		const r = await fetch(`agents/${encodeURIComponent(activeAgent)}/sessions`);
		const sessions = await r.json();
		pane.innerHTML = "";
		if (!sessions.length) {
			pane.innerHTML = '<div class="empty-state">No sessions yet</div>';
			return;
		}
		const tree = document.createElement("div");
		tree.className = "session-tree";
		for (const s of sessions) tree.appendChild(renderSessionRow(s));
		pane.appendChild(tree);
	} catch {
		pane.innerHTML = '<div class="empty-state">Failed to load sessions</div>';
	}
}

function renderSessionRow(session) {
	const wrap = document.createElement("div");
	wrap.dataset.turn = session.turnNumber;

	const isExpanded = expandedSessions.has(session.turnNumber);
	const hdr = document.createElement("div");
	hdr.className = `session-row${session.isReflection ? " reflection" : ""}${isExpanded ? " expanded" : ""}`;

	const badge = session.isReflection
		? '<span class="sr-badge reflection">↺ Reflection</span>'
		: `<span class="sr-badge">Session ${session.turnNumber}</span>`;
	const time = session.startTime ? fmtTime(session.startTime) : "";
	const dur =
		session.durationMs > 0 ? `${(session.durationMs / 1000).toFixed(0)}s` : "";
	const tok =
		session.inputTokens > 0
			? `${Math.round(session.inputTokens / 1000)}k in`
			: "";
	const cost = session.costUsd > 0 ? `$${session.costUsd.toFixed(4)}` : "";
	const calls = session.llmCalls > 0 ? `${session.llmCalls} LLM` : "";
	const tools = session.toolCalls > 0 ? `${session.toolCalls} tools` : "";

	hdr.innerHTML =
		`<span class="sr-label">${badge}</span>` +
		`<span class="sr-meta">` +
		[time, dur, calls, tools, tok, cost]
			.filter(Boolean)
			.map((x) => `<span>${esc(x)}</span>`)
			.join("") +
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
	if (docs.every((d) => d.callSeq != null)) return docs;
	const sorted = [...docs].sort(
		(a, b) => (a.seqInTurn ?? 0) - (b.seqInTurn ?? 0),
	);
	let seq = -1;
	return sorted.map((doc) => {
		if (doc.parentToolUseId) return doc;
		const role = doc.message?.role;
		if (role === "assistant") seq++;
		return { ...doc, callSeq: role === "user" ? -1 : seq };
	});
}

async function expandSession(agentId, turnNumber, container) {
	const r = await fetch(
		`agents/${encodeURIComponent(agentId)}/sessions/${turnNumber}`,
	);
	const data = await r.json();
	container.innerHTML = "";

	const messages = normalizeCallSeq(data.messages || []);
	const llmCalls = data.llmCalls || [];

	const byCallSeq = new Map();
	for (const doc of messages) {
		const seq = doc.callSeq != null ? doc.callSeq : -1;
		if (!byCallSeq.has(seq)) byCallSeq.set(seq, []);
		byCallSeq.get(seq).push(doc);
	}

	const subLoopByToolId = new Map();
	for (const doc of messages) {
		if (doc.parentToolUseId) {
			if (!subLoopByToolId.has(doc.parentToolUseId))
				subLoopByToolId.set(doc.parentToolUseId, []);
			subLoopByToolId.get(doc.parentToolUseId).push(doc);
		}
	}

	const sortedLlmCalls = [...llmCalls].sort(
		(a, b) => new Date(a.savedAt) - new Date(b.savedAt),
	);
	const llmCallBySeq = new Map();
	sortedLlmCalls.forEach((lc, i) => {
		llmCallBySeq.set(i, lc);
	});

	const taskDocs = byCallSeq.get(-1) || [];
	for (const doc of taskDocs) {
		if (doc.message && doc.message.role === "user") {
			const el = document.createElement("div");
			el.className = "st-task-msg";
			const content =
				typeof doc.message.content === "string"
					? doc.message.content
					: (doc.message.content || [])
							.filter((b) => b.type === "text")
							.map((b) => b.text)
							.join("\n");
			el.innerHTML =
				`<span class="st-task-label">Inbox</span>` +
				`<span class="st-task-body">${esc(content.slice(0, 300))}${content.length > 300 ? "…" : ""}</span>`;
			container.appendChild(el);
		}
	}

	const seqs = [...byCallSeq.keys()]
		.filter((s) => s >= 0)
		.sort((a, b) => a - b);
	for (const seq of seqs) {
		const seqDocs = (byCallSeq.get(seq) || []).filter(
			(d) => !d.parentToolUseId,
		);
		const llmMeta = llmCallBySeq.get(seq);
		const node = renderLlmCallGroup(seq, seqDocs, llmMeta, subLoopByToolId);
		container.appendChild(node);
	}

	if (!seqs.length && !taskDocs.length) {
		container.innerHTML =
			'<div class="empty-state">No messages in this session</div>';
	}
}

function renderLlmCallGroup(callSeq, docs, llmMeta, subLoopByToolId) {
	const wrap = document.createElement("div");
	wrap.className = "llm-call-node";

	const assistantDoc = docs.find(
		(d) => d.message && d.message.role === "assistant",
	);
	const toolResultDocs = docs.filter(
		(d) => d.message && d.message.role === "toolResult",
	);

	const hdr = document.createElement("div");
	hdr.className = "llm-call-hdr";
	const inputTok = llmMeta?.usage ? llmMeta.usage.inputTokens || 0 : 0;
	const outputTok = llmMeta?.usage ? llmMeta.usage.outputTokens || 0 : 0;
	const callCost = llmMeta?.usage?.cost ? llmMeta.usage.cost.total || 0 : 0;
	hdr.innerHTML =
		`<span class="lc-label">LLM call ${callSeq}</span>` +
		`<span class="lc-meta">` +
		(inputTok > 0 ? `<span>${Math.round(inputTok / 1000)}k in</span>` : "") +
		(outputTok > 0 ? `<span>${Math.round(outputTok / 1000)}k out</span>` : "") +
		(callCost > 0
			? `<span class="lc-cost">$${callCost.toFixed(4)}</span>`
			: "") +
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
			fillLlmCallBody(
				body,
				assistantDoc,
				toolResultDocs,
				subLoopByToolId,
				llmMeta,
			);
		}
	};

	wrap.appendChild(hdr);
	wrap.appendChild(body);
	return wrap;
}

function fillLlmCallBody(
	body,
	assistantDoc,
	toolResultDocs,
	subLoopByToolId,
	_llmMeta,
) {
	if (!assistantDoc) return;
	const m = assistantDoc.message;
	if (!m) return;

	const blocks = Array.isArray(m.content) ? m.content : [];
	const texts = blocks.filter(
		(b) => b.type === "text" && b.text && b.text.trim(),
	);
	if (texts.length) {
		const el = document.createElement("div");
		el.className = "lc-text";
		el.textContent = texts.map((b) => b.text).join("\n\n");
		body.appendChild(el);
	}

	if (assistantDoc.mentalMapHtml) {
		const mmRow = document.createElement("div");
		mmRow.className = "lc-mm-row";
		mmRow.innerHTML =
			'<span class="lc-mm-label">🧠 Mental Map</span>' +
			'<span class="lc-mm-arrow">▶</span>';
		const mmBody = document.createElement("div");
		mmBody.className = "mm-iframe-wrap";
		mmBody.style.display = "none";
		mmRow.onclick = () => {
			const open = mmBody.style.display !== "none";
			mmBody.style.display = open ? "none" : "";
			mmRow.querySelector(".lc-mm-arrow").textContent = open ? "▶" : "▼";
			if (!open && !mmBody.dataset.filled) {
				mmBody.dataset.filled = "1";
				const iframe = document.createElement("iframe");
				iframe.className = "mm-iframe";
				iframe.setAttribute("sandbox", "allow-same-origin");
				iframe.srcdoc = assistantDoc.mentalMapHtml;
				mmBody.appendChild(iframe);
			}
		};
		body.insertBefore(mmBody, body.firstChild);
		body.insertBefore(mmRow, mmBody);
	}

	const toolCalls = blocks.filter((b) => b.type === "toolCall");
	for (const call of toolCalls) {
		const resultDoc = toolResultDocs.find(
			(d) => d.message && d.message.toolCallId === call.id,
		);
		const subMsgs = subLoopByToolId.get(call.id) || [];
		body.appendChild(renderToolCallRow(call, resultDoc, subMsgs));
	}
}

function renderToolCallRow(toolCallBlock, toolResultDoc, subLoopMessages) {
	const wrap = document.createElement("div");
	wrap.className = "tool-call-node";

	const argsStr = JSON.stringify(toolCallBlock.arguments || {});
	const argPreview = argsStr.length > 80 ? `${argsStr.slice(0, 80)}…` : argsStr;
	const result = toolResultDoc ? toolResultDoc.message : null;
	const resultText = result
		? (result.content || [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("")
				.slice(0, 80)
		: "";
	const isError = result ? result.isError || false : false;

	const hdr = document.createElement("div");
	hdr.className = "tool-call-hdr";
	hdr.innerHTML =
		`<span class="tc-icon">${_toolIcon(toolCallBlock.name)}</span>` +
		`<span class="tc-name">${esc(toolCallBlock.name)}</span>` +
		`<span class="tc-arg">${esc(argPreview)}</span>` +
		(result
			? `<span class="tc-status ${isError ? "err" : "ok"}">${isError ? "✗" : "✓"} ${esc(resultText)}</span>`
			: "") +
		(subLoopMessages.length
			? `<span class="tc-sub">${subLoopMessages.length} sub-loop msgs</span>`
			: "") +
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
			argsEl.textContent = JSON.stringify(
				toolCallBlock.arguments || {},
				null,
				2,
			).slice(0, 500);
			bdy.appendChild(argsEl);
			if (result) {
				const fullResult = (result.content || [])
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("");
				const resEl = document.createElement("pre");
				resEl.className = `tc-full-result ${isError ? "err" : "ok"}`;
				resEl.textContent =
					fullResult.slice(0, 1000) + (fullResult.length > 1000 ? "…" : "");
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
					const subContent =
						role === "assistant"
							? (sub.message.content || [])
									.filter((b) => b.type === "text")
									.map((b) => b.text)
									.join("")
									.slice(0, 200)
							: role === "toolResult"
								? (sub.message.content || [])
										.map((b) => b.text)
										.join("")
										.slice(0, 200)
								: "";
					subEl.innerHTML =
						`<span class="sub-role">${esc(role)}</span>` +
						`<span class="sub-content">${esc(subContent)}</span>`;
					bdy.appendChild(subEl);
				}
			}
		}
	};

	wrap.appendChild(hdr);
	wrap.appendChild(bdy);
	return wrap;
}

// ── Mental Map tab ─────────────────────────────────────────────────────────
async function loadMentalMap() {
	if (!activeAgent) return;
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = '<div class="empty-state">Loading…</div>';
	try {
		const r = await fetch(
			`agents/${encodeURIComponent(activeAgent)}/mental-map`,
		);
		if (!r.ok) {
			pane.innerHTML = '<div class="empty-state">No mental map yet</div>';
			return;
		}
		const data = await r.json();
		if (!data.html) {
			pane.innerHTML = '<div class="empty-state">No mental map yet</div>';
			return;
		}
		pane.innerHTML = "";
		const iframe = document.createElement("iframe");
		iframe.className = "mm-iframe";
		iframe.setAttribute("sandbox", "allow-same-origin");
		iframe.srcdoc = data.html;
		pane.appendChild(iframe);
	} catch {
		pane.innerHTML = '<div class="empty-state">Failed to load mental map</div>';
	}
}

// ── Files tab ──────────────────────────────────────────────────────────────
async function loadFiles(type, agentId) {
	fileBrowserType = type;
	fileBrowserAgentId = agentId;
	await refreshFileBrowser();
}

async function refreshFileBrowser() {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = '<div class="empty-state">Loading…</div>';
	const type = fileBrowserType;
	const agentId = fileBrowserAgentId;
	const url =
		type === "shared"
			? `files/shared?path=${encodeURIComponent(filePath)}`
			: `files/workdir/${encodeURIComponent(agentId)}?path=${encodeURIComponent(filePath)}`;
	try {
		const r = await fetch(url);
		if (!r.ok) {
			pane.innerHTML = '<div class="empty-state">Not available</div>';
			return;
		}
		const data = await r.json();
		pane.innerHTML = "";
		if (data.type === "dir") renderFileTree(pane, data.entries);
		else renderFilePreview(pane, data);
	} catch {
		pane.innerHTML = '<div class="empty-state">Failed to load files</div>';
	}
}

function buildBreadcrumb(onNav) {
	const bc = document.createElement("div");
	bc.className = "file-breadcrumb";
	const parts = filePath ? filePath.split("/").filter(Boolean) : [];

	// Up button — visible whenever we're inside a subdirectory
	if (filePath) {
		const parentPath = filePath.includes("/")
			? filePath.split("/").slice(0, -1).join("/")
			: "";
		const upBtn = document.createElement("button");
		upBtn.type = "button";
		upBtn.className = "file-up-btn";
		upBtn.title = "Go up one level";
		upBtn.textContent = "↑ Up";
		upBtn.onclick = () => onNav(parentPath);
		bc.appendChild(upBtn);
	}

	const rootLabel =
		fileBrowserType === "shared"
			? "mission"
			: (fileBrowserAgentId ?? "workdir");
	const rootSeg = document.createElement("span");
	rootSeg.className = "file-bc-seg";
	rootSeg.textContent = rootLabel;
	rootSeg.onclick = () => onNav("");
	bc.appendChild(rootSeg);

	parts.forEach((part, i) => {
		const path = parts.slice(0, i + 1).join("/");
		const sep = document.createElement("span");
		sep.className = "file-bc-sep";
		sep.textContent = " / ";
		bc.appendChild(sep);
		const seg = document.createElement("span");
		seg.className = "file-bc-seg";
		seg.textContent = part;
		seg.onclick = () => onNav(path);
		bc.appendChild(seg);
	});

	return bc;
}

function renderFileTree(pane, entries) {
	const nav = (path) => {
		filePath = path;
		refreshFileBrowser();
	};

	pane.appendChild(buildBreadcrumb(nav));

	const list = document.createElement("div");
	list.className = "file-tree";

	const sorted = [...(entries || [])].sort((a, b) => {
		if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	for (const entry of sorted) {
		const row = document.createElement("div");
		row.className = `file-entry ${entry.type}`;
		const icon = entry.type === "dir" ? "📂" : "📄";
		const size = entry.size ? ` (${fmtBytes(entry.size)})` : "";
		row.innerHTML =
			`<span class="file-entry-icon">${icon}</span>` +
			`<span class="file-entry-name">${esc(entry.name)}${esc(size)}</span>`;
		const entryPath = filePath ? `${filePath}/${entry.name}` : entry.name;
		row.onclick = () => nav(entryPath);
		list.appendChild(row);
	}

	pane.appendChild(list);
}

function renderFilePreview(pane, data) {
	const nav = (path) => {
		filePath = path;
		refreshFileBrowser();
	};

	pane.appendChild(buildBreadcrumb(nav));

	const preview = document.createElement("div");
	preview.className = "file-preview";

	if (data.encoding === "binary") {
		preview.innerHTML =
			'<div class="empty-state">Binary file — cannot preview</div>';
	} else if (data.encoding === "base64") {
		const img = document.createElement("img");
		img.src = `data:${data.mimeType};base64,${data.content}`;
		img.style.maxWidth = "100%";
		preview.appendChild(img);
	} else {
		const isMarkdown =
			filePath.endsWith(".md") || filePath.endsWith(".markdown");
		const content = document.createElement("div");
		content.className = "file-preview-content";
		if (isMarkdown) {
			content.innerHTML = md(data.content || "");
		} else {
			const pre = document.createElement("pre");
			pre.textContent = data.content || "";
			content.appendChild(pre);
		}
		if (data.truncated) {
			const note = document.createElement("div");
			note.className = "file-truncated-note";
			note.textContent = "… (file truncated at 200 KB)";
			content.appendChild(note);
		}
		preview.appendChild(content);
	}

	pane.appendChild(preview);
}

function fmtBytes(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Schedule tab ───────────────────────────────────────────────────────────
async function loadSchedule() {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = '<div class="empty-state">Loading…</div>';
	try {
		const r = await fetch("schedule");
		scheduleData = await r.json();
		renderSchedule();
	} catch {
		pane.innerHTML = '<div class="empty-state">Failed to load schedule</div>';
	}
}

function renderSchedule() {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = "";
	if (!scheduleData.length) {
		pane.innerHTML = '<div class="empty-state">No scheduled messages</div>';
		return;
	}
	const table = document.createElement("table");
	table.className = "schedule-table";
	table.innerHTML = `<thead><tr><th>To</th><th>Subject</th><th>When</th><th></th></tr></thead>`;
	const tbody = document.createElement("tbody");
	for (const s of scheduleData) {
		const when = s.scheduledFor
			? fmtTime(s.scheduledFor)
			: s.cronExpression
				? `cron: ${s.cronExpression}`
				: "—";
		const tr = document.createElement("tr");
		tr.innerHTML =
			`<td>${esc((s.to || []).join(", "))}</td>` +
			`<td>${esc(s.subject || "")}</td>` +
			`<td>${esc(when)}</td>`;
		const td = document.createElement("td");
		const btn = document.createElement("button");
		btn.className = "btn btn-cancel";
		btn.textContent = "Cancel";
		btn.onclick = () => cancelSchedule(s.id);
		td.appendChild(btn);
		tr.appendChild(td);
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	pane.appendChild(table);
}

async function cancelSchedule(id) {
	await fetch(`schedule/${encodeURIComponent(id)}`, { method: "DELETE" });
	await loadSchedule();
}

async function refreshSchedule() {
	try {
		const r = await fetch("schedule");
		scheduleData = await r.json();
		if (activeTab === "schedule" && activeAgent === null) renderSchedule();
	} catch {}
}

// ── Log tab ────────────────────────────────────────────────────────────────
async function loadLog() {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = '<div class="empty-state">Loading…</div>';
	try {
		const r = await fetch("log?lines=300");
		if (!r.ok) {
			pane.innerHTML = '<div class="empty-state">Log not available</div>';
			return;
		}
		const text = await r.text();
		pane.innerHTML = "";
		const toolbar = document.createElement("div");
		toolbar.className = "log-toolbar";
		const refreshBtn = document.createElement("button");
		refreshBtn.className = "btn";
		refreshBtn.textContent = "Refresh";
		refreshBtn.onclick = loadLog;
		toolbar.appendChild(refreshBtn);
		pane.appendChild(toolbar);
		const pre = document.createElement("pre");
		pre.className = "log-content";
		pre.textContent = text;
		pane.appendChild(pre);
		pre.scrollTop = pre.scrollHeight;
	} catch {
		pane.innerHTML = '<div class="empty-state">Failed to load log</div>';
	}
}

// ── Stats tab ──────────────────────────────────────────────────────────────
function renderStats() {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = "";
	const total = Object.values(agentCosts).reduce((s, v) => s + v, 0);

	const grid = document.createElement("div");
	grid.className = "stats-grid";

	const totalCard = document.createElement("div");
	totalCard.className = "stat-card";
	totalCard.innerHTML =
		`<div class="stat-label">Mission Total</div>` +
		`<div class="stat-value">$${total.toFixed(4)}</div>`;
	grid.appendChild(totalCard);

	if (maxCostUsd) {
		const capCard = document.createElement("div");
		capCard.className = "stat-card";
		const pct = Math.min(100, (total / maxCostUsd) * 100).toFixed(1);
		capCard.innerHTML =
			`<div class="stat-label">Spending Cap</div>` +
			`<div class="stat-value">$${maxCostUsd.toFixed(2)} (${pct}% used)</div>`;
		grid.appendChild(capCard);
	}

	const agentCount = document.createElement("div");
	agentCount.className = "stat-card";
	agentCount.innerHTML =
		`<div class="stat-label">Agents</div>` +
		`<div class="stat-value">${AGENTS.length}</div>`;
	grid.appendChild(agentCount);

	pane.appendChild(grid);

	if (Object.keys(agentCosts).length) {
		const table = document.createElement("table");
		table.className = "stat-table";
		table.innerHTML = `<thead><tr><th>Agent</th><th>Cost</th><th>Context</th></tr></thead>`;
		const tbody = document.createElement("tbody");
		for (const [id, cost] of Object.entries(agentCosts).sort(
			(a, b) => b[1] - a[1],
		)) {
			const ctx = agentContextTokens[id] ?? 0;
			const ctxPct = Math.round((ctx / CTX_LIMIT) * 100);
			const tr = document.createElement("tr");
			tr.innerHTML =
				`<td class="ac-${id}">${esc(id)}</td>` +
				`<td>$${cost.toFixed(4)}</td>` +
				`<td>${ctx > 0 ? `${Math.round(ctx / 1000)}k (${ctxPct}%)` : "—"}</td>`;
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		pane.appendChild(table);
	}
}

// ── Step / Kill ────────────────────────────────────────────────────────────
function renderStepBtn() {
	const btn = document.getElementById("step-btn");
	if (!btn) return;
	if (stepEnabled && stepWaiting) {
		btn.textContent = "▶ Run";
		btn.className = "btn btn-step waiting";
		btn.onclick = advanceStep;
	} else if (stepEnabled) {
		btn.textContent = "Step ●";
		btn.className = "btn btn-step on";
		btn.onclick = toggleStep;
	} else {
		btn.textContent = "Step ○";
		btn.className = "btn btn-step";
		btn.onclick = toggleStep;
	}
}

async function toggleStep() {
	const r = await fetch("toggle-step", { method: "POST" });
	const d = await r.json();
	stepEnabled = d.stepEnabled;
	if (!stepEnabled) stepWaiting = false;
	renderStepBtn();
}

async function advanceStep() {
	await fetch("step", { method: "POST" });
}

// biome-ignore lint/correctness/noUnusedVariables: called from HTML onclick
async function killDaemon() {
	if (stopped) return;
	if (
		!confirm(
			"Stop all agents and shut down the daemon?\nThis cannot be undone.",
		)
	)
		return;
	const btn = document.getElementById("kill-btn");
	if (btn) {
		btn.disabled = true;
		btn.textContent = "Stopping…";
	}
	try {
		await fetch("stop", { method: "POST" });
	} catch {
		if (btn) {
			btn.disabled = false;
			btn.textContent = "■ Kill";
		}
	}
}

// ── Uptime ─────────────────────────────────────────────────────────────────
function updateUptime() {
	const sec = Math.floor((Date.now() - startedAt) / 1000);
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	const el = document.getElementById("hup");
	if (el)
		el.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Tool icons ─────────────────────────────────────────────────────────────
function _toolIcon(name) {
	return (
		{
			Bash: "⚙",
			WriteFile: "✍",
			EditFile: "✏",
			PostMessage: "✉",
			UpdateMentalMap: "🧠",
			FetchUrl: "🌐",
			BrowseWeb: "🌐",
			SearchWeb: "🔍",
			InspectImage: "🖼",
			ListTeam: "👥",
			ListMessages: "📬",
			ReadMessage: "📨",
			Research: "🔬",
		}[name] || "🔧"
	);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function fmtTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const isToday = d.toDateString() === now.toDateString();
	return isToday
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString([], { month: "short", day: "numeric" }) +
				" " +
				d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Theme toggle ──────────────────────────────────────────────────────────
function _toggleTheme() {
	const light = document.body.classList.toggle("light");
	localStorage.setItem("magi-theme", light ? "light" : "dark");
}

(function applyStoredTheme() {
	if (localStorage.getItem("magi-theme") !== "dark") {
		document.body.classList.add("light");
	}
})();

// ── Panel resize ──────────────────────────────────────────────────────────
(function initPanelResize() {
	const handle = document.getElementById("panel-resize-handle");
	const main = document.querySelector("main");
	if (!handle || !main) return;

	const MIN_W = 220;
	const MAX_W = 800;
	const STORED_KEY = "magi-left-col-w";

	function applyWidth(w) {
		const clamped = Math.max(MIN_W, Math.min(MAX_W, w));
		document.documentElement.style.setProperty("--left-col-w", `${clamped}px`);
		return clamped;
	}

	// Restore saved width.
	const saved = parseInt(localStorage.getItem(STORED_KEY) ?? "", 10);
	if (!Number.isNaN(saved)) applyWidth(saved);

	let startX = 0;
	let startW = 0;

	function onMouseMove(e) {
		applyWidth(startW + (e.clientX - startX));
	}

	function onMouseUp(e) {
		handle.classList.remove("dragging");
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
		const finalW = applyWidth(startW + (e.clientX - startX));
		localStorage.setItem(STORED_KEY, String(finalW));
	}

	handle.addEventListener("mousedown", (e) => {
		startX = e.clientX;
		startW = parseInt(
			getComputedStyle(document.documentElement).getPropertyValue(
				"--left-col-w",
			),
			10,
		);
		handle.classList.add("dragging");
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
		e.preventDefault();
	});
})();

// ── Start ──────────────────────────────────────────────────────────────────
init().catch((e) => console.error("[app] init failed:", e));
