// MAGI Monitor — client-side application
// Bootstraps by fetching /team, /status, /playbook from the server.

let AGENTS = [];
let PLAYBOOK = [];

// ── State ─────────────────────────────────────────────────────────────────
let activeAgent = null;
let activeSubTab = "mm";
let missionStarted = false;
let stepEnabled = false;
let stepWaiting = false;
let runningAgent = null;
let pendingAgents = [];
let startedAt = Date.now();
let maxCostUsd = null;
let stopped = false;

// ── Bootstrap ─────────────────────────────────────────────────────────────
async function init() {
	const [teamRes, statusRes, playbookRes, mailboxRes] = await Promise.all([
		fetch("/team"),
		fetch("/status"),
		fetch("/playbook"),
		fetch("/mailbox"),
	]);
	AGENTS = await teamRes.json();
	PLAYBOOK = await playbookRes.json();
	const status = await statusRes.json();
	const history = await mailboxRes.json();

	populateAgentTabs(AGENTS);
	populateToChecks(AGENTS);
	injectAgentColors(AGENTS);

	applyStatus(status);

	// Pre-populate the feed with historical mailbox messages.
	history.forEach((m) => {
		addMailMsg(m);
	});

	connectSSE();
}

function populateAgentTabs(agents) {
	const bar = document.getElementById("agent-tabs");
	const playbook = document.getElementById("tab-playbook");
	agents.forEach((a, _i) => {
		const tab = document.createElement("div");
		tab.className = `agent-tab ac-${a.id}`;
		tab.dataset.id = a.id;
		tab.textContent = a.name;
		tab.onclick = () => {
			selectAgent(a.id);
		};
		bar.insertBefore(tab, playbook);
	});
}

function populateToChecks(agents) {
	const box = document.getElementById("to-checks");
	box.innerHTML = "";
	agents.forEach((a) => {
		const lbl = document.createElement("label");
		const chk = document.createElement("input");
		chk.type = "checkbox";
		chk.value = a.id;
		chk.id = `chk-${a.id}`;
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
let es;
function connectSSE() {
	es = new EventSource("/events");
	es.onopen = () => {
		document.getElementById("dot").classList.remove("dead");
	};
	es.onerror = () => {
		document.getElementById("dot").classList.add("dead");
	};

	es.addEventListener("status", (e) => {
		applyStatus(JSON.parse(e.data));
	});
	es.addEventListener("mailbox-msg", (e) => {
		addMailMsg(JSON.parse(e.data));
	});
	es.addEventListener("llm-call", (e) => {
		const d = JSON.parse(e.data);
		updateCostDisplay(d.missionTotalUsd, maxCostUsd);
		addLlmCallToUsage(d);
	});
	es.addEventListener("step-paused", () => {
		stepWaiting = true;
		renderStepBtn();
		renderQueue();
	});
	es.addEventListener("step-resumed", () => {
		stepWaiting = false;
		renderStepBtn();
		renderQueue();
	});
	es.addEventListener("mental-map-update", (e) => {
		const d = JSON.parse(e.data);
		if (d.agentId === activeAgent && activeSubTab === "mm")
			renderMentalMap(d.html);
	});
	es.addEventListener("conversation-update", (e) => {
		const d = JSON.parse(e.data);
		if (d.agentId !== activeAgent) return;
		if (activeSubTab === "cv") appendConvMsg(d.message);
		else if (activeSubTab === "act") appendActivityDoc(d.message);
	});
	es.addEventListener("shutdown", (e) => {
		const d = JSON.parse(e.data);
		document.getElementById("dot").classList.add("dead");
		document.getElementById("stop-btn").disabled = true;
		document.getElementById("stop-btn").textContent = "\u2014 stopped";
		addSysMsg(`Daemon stopped: ${d.reason || "unknown"}`);
		stopped = true;
	});
	es.addEventListener("started", () => {
		setStarted(true);
	});
	es.addEventListener("agent-status", (e) => {
		const d = JSON.parse(e.data);
		runningAgent = d.running;
		pendingAgents = d.pending ?? [];
		renderQueue();
		renderAgentTabIndicators();
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
	updateUsageTable(s.agents, s.missionTotalUsd, s.maxCostUsd);
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

// ── Usage bar ──────────────────────────────────────────────────────────────
const agentCosts = {};

function addLlmCallToUsage(d) {
	agentCosts[d.agentId] = d.agentTotalUsd;
	const row = document.getElementById("usage-row");
	row.innerHTML = `${Object.entries(agentCosts)
		.sort((a, b) => b[1] - a[1])
		.map(
			(e) =>
				`<span><span class="u-agent ac-${e[0]}">${e[0]}</span> <span class="u-val">$${e[1].toFixed(4)}</span></span>`,
		)
		.join(
			"",
		)}<span class="u-total">mission $${d.missionTotalUsd.toFixed(4)}</span>`;
	if (maxCostUsd) {
		document.getElementById("cap-wrap").style.display = "block";
		const pct = Math.min(100, (d.missionTotalUsd / maxCostUsd) * 100);
		const fill = document.getElementById("cap-fill");
		fill.style.width = `${pct}%`;
		fill.style.background =
			pct > 80 ? "var(--red)" : pct > 50 ? "var(--yellow)" : "var(--accent)";
	}
}

function updateUsageTable(agents) {
	if (!agents || !agents.length) return;
	agents.forEach((a) => {
		agentCosts[a.agentId] = a.costUsd;
	});
	const total = agents.reduce((s, a) => s + a.costUsd, 0);
	updateCostDisplay(total, maxCostUsd);
	const row = document.getElementById("usage-row");
	row.innerHTML = `${agents
		.map(
			(a) =>
				`<span><span class="u-agent ac-${a.agentId}">${a.agentId}</span> <span class="u-val">$${a.costUsd.toFixed(4)}</span></span>`,
		)
		.join("")}<span class="u-total">mission $${total.toFixed(4)}</span>`;
}

// ── Feed ───────────────────────────────────────────────────────────────────
function addMailMsg(m) {
	const feed = document.getElementById("feed");
	feed.querySelector(".empty-state")?.remove();
	const preview = m.bodyPreview || m.body || "";
	const full = m.body || preview;
	const truncated = full.length > preview.length;
	const div = document.createElement("div");
	div.className = `msg ab-${m.from}`;
	div.innerHTML =
		'<div class="msg-hdr">' +
		'<span class="msg-from ac-' +
		m.from +
		'">' +
		esc(m.from) +
		"</span>" +
		'<span class="msg-to">\u2192 ' +
		esc(m.to.join(", ")) +
		"</span>" +
		'<span class="msg-time">' +
		fmtTime(m.timestamp) +
		"</span>" +
		"</div>" +
		'<div class="msg-subj">' +
		esc(m.subject) +
		"</div>" +
		'<div class="msg-body">' +
		esc(preview) +
		"</div>" +
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
	feed.appendChild(div);
	feed.scrollTop = feed.scrollHeight;
}

function addSysMsg(text) {
	const feed = document.getElementById("feed");
	feed.querySelector(".empty-state")?.remove();
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
	convLastTurn = -1;
	document.querySelectorAll(".agent-tab").forEach((t) => {
		t.classList.toggle("active", t.dataset.id === id);
	});
	document.getElementById("tab-playbook").classList.remove("active");
	document.getElementById("sub-tabs-bar").style.display = "";
	loadDetail();
}

function _selectSubTab(tab) {
	activeSubTab = tab;
	document.getElementById("st-mm").classList.toggle("active", tab === "mm");
	document.getElementById("st-act").classList.toggle("active", tab === "act");
	document.getElementById("st-cv").classList.toggle("active", tab === "cv");
	loadDetail();
}

async function loadDetail() {
	if (!activeAgent) return;
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = '<div class="empty-state">Loading\u2026</div>';
	if (activeSubTab === "mm") {
		const r = await fetch(`/agents/${activeAgent}/mental-map`);
		const data = await r.json();
		renderMentalMap(data.html);
	} else if (activeSubTab === "act") {
		const r = await fetch(`/agents/${activeAgent}/conversation`);
		const docs = await r.json();
		renderActivity(docs);
	} else {
		const r = await fetch(`/agents/${activeAgent}/conversation`);
		const docs = await r.json();
		renderConversation(docs);
	}
}

function renderMentalMap(html) {
	const pane = document.getElementById("detail-pane");
	if (!html) {
		pane.innerHTML = '<div class="empty-state">Mental map is empty</div>';
		return;
	}
	const div = document.createElement("div");
	div.className = "mental-map-html";
	div.innerHTML = html;
	pane.innerHTML = "";
	pane.appendChild(div);
}

// toolCallId → result-slot DOM element; keyed per agent to survive tab switches
const convToolBoxes = new Map();
let convLastTurn = -1;

function renderConversation(docs) {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = "";
	convToolBoxes.clear();
	convLastTurn = -1;
	if (!docs.length) {
		pane.innerHTML = '<div class="empty-state">No conversation yet</div>';
		return;
	}
	docs.forEach((doc) => {
		_renderDoc(doc, pane);
	});
	pane.scrollTop = pane.scrollHeight;
}

function appendConvMsg(doc) {
	const pane = document.getElementById("detail-pane");
	pane.querySelector(".empty-state")?.remove();
	_renderDoc(doc, pane);
	pane.scrollTop = pane.scrollHeight;
}

// ── Activity tab ───────────────────────────────────────────────────────────
let actLastTurn = -1;

function renderActivity(docs) {
	const pane = document.getElementById("detail-pane");
	pane.innerHTML = "";
	actLastTurn = -1;
	if (!docs.length) {
		pane.innerHTML = '<div class="empty-state">No activity yet</div>';
		return;
	}
	docs.forEach((doc) => {
		_renderActivityDoc(doc, pane);
	});
	pane.scrollTop = pane.scrollHeight;
}

function appendActivityDoc(doc) {
	const pane = document.getElementById("detail-pane");
	pane.querySelector(".empty-state")?.remove();
	_renderActivityDoc(doc, pane);
	pane.scrollTop = pane.scrollHeight;
}

function _renderActivityDoc(doc, pane) {
	const m = doc.message;
	if (!m) return;
	const turn = doc.turnNumber ?? 0;

	if (turn !== actLastTurn) {
		actLastTurn = turn;
		const hdr = document.createElement("div");
		hdr.className = "act-turn-hdr";
		hdr.textContent = `\u2014 Turn ${turn} \u2014`;
		pane.appendChild(hdr);
	}

	if (m.role === "assistant") {
		const blocks = Array.isArray(m.content) ? m.content : [];
		const texts = blocks.filter((b) => b.type === "text" && b.text?.trim());
		const calls = blocks.filter((b) => b.type === "toolCall");

		texts.forEach((b) => {
			const t = b.text.trim();
			const el = document.createElement("div");
			el.className = "act-item act-text";
			el.textContent = t.length > 140 ? `${t.slice(0, 140)}\u2026` : t;
			pane.appendChild(el);
		});

		calls.forEach((call) => {
			const isPM = call.name === "PostMessage";
			const el = document.createElement("div");
			el.className = `act-item act-tool${isPM ? " act-pm" : ""}`;
			let label = `${_toolIcon(call.name)} ${call.name}`;
			if (isPM) {
				const args = call.arguments || {};
				const to = Array.isArray(args.to) ? args.to.join(", ") : args.to || "?";
				label += ` \u2192 ${to}`;
				if (args.subject)
					label += ` \u201c${String(args.subject).slice(0, 60)}\u201d`;
			} else if (call.arguments) {
				const keys = Object.keys(call.arguments);
				const key = keys[0];
				if (key) {
					const val = String(call.arguments[key] ?? "");
					label += ` ${val.slice(0, 80)}`;
				}
			}
			el.textContent = label;
			pane.appendChild(el);
		});
	} else if (m.role === "toolResult" && m.isError) {
		const el = document.createElement("div");
		el.className = "act-item act-error";
		el.textContent = `\u2717 ${m.toolName || "?"} failed`;
		pane.appendChild(el);
	}
}

function _renderDoc(doc, pane) {
	const m = doc.message;
	if (!m) return;
	const turn = doc.turnNumber ?? 0;
	const agentId = doc.agentId ?? activeAgent ?? "";

	if (turn !== convLastTurn) {
		convLastTurn = turn;
		const hdr = document.createElement("div");
		hdr.className = "conv-turn-hdr";
		hdr.textContent = `\u2014 Turn ${turn} \u2014`;
		pane.appendChild(hdr);
	}

	if (m.role === "user") {
		const content =
			typeof m.content === "string"
				? m.content
				: (m.content || [])
						.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("\n");
		const el = document.createElement("div");
		el.className = "conv-bubble conv-bubble-user";
		el.innerHTML =
			'<div class="conv-avatar av-user">\uD83D\uDCE8</div>' +
			'<div class="conv-body">' +
			'<div class="conv-label">Operator / Mailbox</div>' +
			'<div class="conv-text">' +
			esc(content) +
			"</div>" +
			"</div>";
		pane.appendChild(el);
	} else if (m.role === "assistant") {
		const blocks = Array.isArray(m.content) ? m.content : [];
		const thinking = blocks.filter(
			(b) => b.type === "thinking" && b.thinking?.trim(),
		);
		const texts = blocks.filter((b) => b.type === "text" && b.text?.trim());
		const calls = blocks.filter((b) => b.type === "toolCall");

		if (thinking.length) {
			const el = document.createElement("div");
			el.className = "conv-bubble";
			const full = thinking.map((b) => b.thinking).join("\n\n");
			el.innerHTML =
				'<div class="conv-avatar av-think">\uD83D\uDCAD</div>' +
				'<div class="conv-body">' +
				'<div class="conv-label">Thinking</div>' +
				'<div class="conv-text conv-think-text">' +
				esc(full.slice(0, 600)) +
				(full.length > 600 ? "\u2026" : "") +
				"</div>" +
				"</div>";
			pane.appendChild(el);
		}
		if (texts.length) {
			const el = document.createElement("div");
			el.className = "conv-bubble conv-bubble-agent";
			el.innerHTML =
				'<div class="conv-avatar av-agent">AI</div>' +
				'<div class="conv-body">' +
				'<div class="conv-text">' +
				esc(texts.map((b) => b.text).join("\n\n")) +
				"</div>" +
				"</div>";
			pane.appendChild(el);
		}
		calls.forEach((call) => {
			const box = _makeToolBox(call.name, call.arguments);
			pane.appendChild(box.el);
			convToolBoxes.set(`${agentId}:${call.id}`, box.resultEl);
		});
	} else if (m.role === "toolResult") {
		const slot = convToolBoxes.get(`${agentId}:${m.toolCallId}`);
		if (slot) {
			_fillResult(slot, m);
		} else {
			// Orphaned result (e.g. page reload mid-turn) — show as standalone box
			const el = document.createElement("div");
			el.className = "conv-tool-box";
			const txt = (m.content || [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("")
				.slice(0, 500);
			el.innerHTML =
				'<div class="conv-tool-hdr" onclick="toggleToolBox(this)">' +
				'<span class="conv-tool-icon">' +
				_toolIcon(m.toolName) +
				"</span>" +
				'<span class="conv-tool-name">' +
				esc(m.toolName) +
				"</span>" +
				'<span class="conv-tool-arrow">\u25bc</span>' +
				"</div>" +
				'<div class="conv-tool-body open">' +
				'<div class="conv-tool-result ' +
				(m.isError ? "err" : "ok") +
				'">' +
				esc(txt) +
				"</div>" +
				"</div>";
			pane.appendChild(el);
		}
	}
}

function _makeToolBox(name, args) {
	const el = document.createElement("div");
	el.className = "conv-tool-box";
	const argsStr = JSON.stringify(args, null, 2);
	el.innerHTML =
		'<div class="conv-tool-hdr" onclick="toggleToolBox(this)">' +
		'<span class="conv-tool-icon">' +
		_toolIcon(name) +
		"</span>" +
		'<span class="conv-tool-name">' +
		esc(name) +
		"</span>" +
		'<span class="conv-tool-arrow">\u25bc</span>' +
		"</div>" +
		'<div class="conv-tool-body open">' +
		'<div class="conv-tool-args">' +
		esc(argsStr) +
		"</div>" +
		'<div class="conv-tool-result pending">\u23f3 running\u2026</div>' +
		"</div>";
	const resultEl = el.querySelector(".conv-tool-result");
	return { el: el, resultEl: resultEl };
}

function _fillResult(el, m) {
	const txt = (m.content || [])
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("");
	el.className = `conv-tool-result ${m.isError ? "err" : "ok"}`;
	el.textContent = txt.slice(0, 1000) + (txt.length > 1000 ? "\u2026" : "");
}

function _toggleToolBox(hdr) {
	const body = hdr.nextElementSibling;
	const arrow = hdr.querySelector(".conv-tool-arrow");
	const open = body.classList.toggle("open");
	arrow.textContent = open ? "\u25bc" : "\u25b6";
}

function _toolIcon(name) {
	return (
		{
			Bash: "\u2699",
			WriteFile: "\u270d",
			EditFile: "\u270f",
			PostMessage: "\u2709",
			UpdateMentalMap: "\uD83E\uDDE0",
			FetchUrl: "\uD83C\uDF10",
			BrowseWeb: "\uD83C\uDF10",
			SearchWeb: "\uD83D\uDD0D",
			InspectImage: "\uD83D\uDDBC",
			ListTeam: "\uD83D\uDC65",
			ListMessages: "\uD83D\uDCEC",
			ReadMessage: "\uD83D\uDCE8",
		}[name] || "\uD83D\uDD27"
	);
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

async function _startMission() {
	if (missionStarted) return;
	await fetch("/start", { method: "POST" });
	setStarted(true);
}

async function _toggleStep() {
	const r = await fetch("/toggle-step", { method: "POST" });
	const d = await r.json();
	stepEnabled = d.stepEnabled;
	if (!stepEnabled) stepWaiting = false;
	renderStepBtn();
	renderQueue();
}

async function _advanceStep() {
	await fetch("/step", { method: "POST" });
}

function renderQueue() {
	const strip = document.getElementById("queue-strip");
	if (!strip) return;

	if (stepEnabled && stepWaiting && runningAgent) {
		const name = agentDisplayName(runningAgent);
		let html = `<button class="btn-run" onclick="advanceStep()">\u25b6 Run ${esc(name)}</button>`;
		pendingAgents.forEach((id) => {
			html += `<span class="q-arrow">\u2192</span><span class="q-agent">${esc(agentDisplayName(id))}</span>`;
		});
		strip.innerHTML = html;
		return;
	}

	if (runningAgent) {
		let html = `<span class="q-agent running">${esc(agentDisplayName(runningAgent))}</span>`;
		pendingAgents.forEach((id) => {
			html += `<span class="q-arrow">\u2192</span><span class="q-agent">${esc(agentDisplayName(id))}</span>`;
		});
		strip.innerHTML = html;
		return;
	}

	strip.innerHTML =
		'<span class="q-idle">Idle \u2014 waiting for messages</span>';
}

function agentDisplayName(id) {
	const a = AGENTS.find((a) => a.id === id);
	return a ? a.name : id;
}

function renderAgentTabIndicators() {
	document.querySelectorAll(".agent-tab[data-id]").forEach((tab) => {
		const id = tab.dataset.id;
		const base =
			tab.dataset.baseName || tab.textContent.replace(/^\u25b6 /, "");
		tab.dataset.baseName = base;
		tab.textContent = id === runningAgent ? `\u25b6 ${base}` : base;
	});
}

function _stopDaemon() {
	if (stopped) return;
	if (
		!confirm("Stop the MAGI daemon? This will abort the current mission cycle.")
	)
		return;
	fetch("/stop", { method: "POST" }).catch(() => {});
	document.getElementById("stop-btn").disabled = true;
	document.getElementById("stop-btn").textContent = "Stopping\u2026";
}

// ── Compose ────────────────────────────────────────────────────────────────
function _openCompose() {
	document.getElementById("compose-overlay").classList.remove("hidden");
	document.getElementById("compose-body").focus();
}

function closeCompose() {
	delete document.getElementById("compose-overlay").dataset.playbookIdx;
	document.getElementById("compose-overlay").classList.add("hidden");
}

function _closeComposeIfBg(e) {
	if (e.target === document.getElementById("compose-overlay")) closeCompose();
}

function checkAll() {
	document.querySelectorAll("#to-checks input[type=checkbox]").forEach((c) => {
		c.checked = true;
	});
}

async function _sendMessage() {
	const to = [...document.querySelectorAll("#to-checks input:checked")].map(
		(c) => c.value,
	);
	const subject = document.getElementById("compose-subject").value.trim();
	const message = document.getElementById("compose-body").value.trim();
	if (!to.length) {
		alert("Select at least one recipient");
		return;
	}
	if (!message) {
		alert("Message body is required");
		return;
	}
	const r = await fetch("/send-message", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ to: to, subject: subject, message: message }),
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
		document.querySelectorAll("#to-checks input").forEach((c) => {
			c.checked = false;
		});
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

function _selectPlaybook() {
	activeAgent = null;
	document.querySelectorAll(".agent-tab").forEach((t) => {
		t.classList.remove("active");
	});
	document.getElementById("tab-playbook").classList.add("active");
	document.getElementById("sub-tabs-bar").style.display = "none";
	renderPlaybook();
}

function renderPlaybook() {
	const pane = document.getElementById("detail-pane");
	if (!PLAYBOOK.length) {
		pane.innerHTML =
			'<div class="empty-state">No playbook messages defined</div>';
		return;
	}
	pane.innerHTML = "";
	PLAYBOOK.forEach((entry, i) => {
		const sent = playbookSent.has(i);
		const div = document.createElement("div");
		div.className = `pb-item${sent ? " sent" : ""}`;
		const toHtml = entry.to
			.map((t) => `<span class="ac-${esc(t)}">${esc(t)}</span>`)
			.join(", ");
		div.innerHTML =
			'<div class="pb-title">' +
			esc(entry.title) +
			"</div>" +
			'<div class="pb-meta">To: ' +
			toHtml +
			"</div>" +
			'<div class="pb-preview">' +
			esc(entry.body.slice(0, 200)) +
			(entry.body.length > 200 ? "\u2026" : "") +
			"</div>" +
			'<div class="pb-actions">' +
			'<button class="btn pb-edit" onclick="editPlaybookEntry(' +
			i +
			')">\u270f Edit &amp; Send</button>' +
			(sent ? '<span class="pb-sent-badge">\u2713 sent</span>' : "") +
			"</div>";
		pane.appendChild(div);
	});
}

function _editPlaybookEntry(i) {
	const entry = PLAYBOOK[i];
	if (!entry) return;
	document.querySelectorAll("#to-checks input[type=checkbox]").forEach((c) => {
		c.checked = entry.to.includes(c.value);
	});
	document.getElementById("compose-subject").value = entry.subject;
	document.getElementById("compose-body").value = entry.body;
	document.getElementById("compose-overlay").dataset.playbookIdx = String(i);
	document.getElementById("compose-overlay").classList.remove("hidden");
	document.getElementById("compose-body").focus();
}

// ── Utilities ──────────────────────────────────────────────────────────────
function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function fmtTime(ts) {
	return new Date(ts).toLocaleTimeString("en", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

// ── Start ──────────────────────────────────────────────────────────────────
init().catch((e) => {
	console.error("[app] init failed:", e);
});
