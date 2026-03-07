import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { Db } from "mongodb";
import type { UsageAccumulator } from "./usage.js";

// ---------------------------------------------------------------------------
// Event types pushed to clients
// ---------------------------------------------------------------------------

export type MonitorEventType =
	| "mailbox-msg" // new message in the mailbox
	| "llm-call" // LLM call completed (with usage)
	| "shutdown" // daemon is shutting down
	| "cost-limit"; // MAX_COST_USD exceeded — aborting

export interface MailboxMsgPayload {
	id: string;
	from: string;
	to: string[];
	subject: string;
	bodyPreview: string;
	timestamp: string;
}

export interface LlmCallPayload {
	agentId: string;
	input: number;
	output: number;
	cacheRead: number;
	callCostUsd: number;
	agentTotalUsd: number;
	missionTotalUsd: number;
}

// ---------------------------------------------------------------------------
// Monitor server
// ---------------------------------------------------------------------------

/**
 * Lightweight HTTP + SSE monitoring server.
 *
 * - GET /          → HTML dashboard
 * - GET /events    → SSE stream of MonitorEvents
 * - GET /status    → JSON snapshot (usage + mission info)
 * - POST /stop     → graceful daemon shutdown
 *
 * Port: MONITOR_PORT env var (default 4000). Set to 0 to disable.
 */
export class MonitorServer {
	private readonly clients = new Set<ServerResponse>();
	private readonly server;

	constructor(
		private readonly db: Db,
		private readonly missionId: string,
		private readonly missionName: string,
		private readonly model: string,
		private readonly accumulator: UsageAccumulator,
		private readonly onStop: () => void,
		private readonly maxCostUsd: number | null,
		private readonly startedAt = new Date(),
	) {
		this.server = createServer((req, res) =>
			this.handleRequest(req, res).catch((e) => {
				console.error("[monitor] Request error:", e);
				if (!res.headersSent) {
					res.writeHead(500).end();
				}
			}),
		);
	}

	// ── Public API ────────────────────────────────────────────────────────────

	push(type: MonitorEventType, payload: unknown): void {
		const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const client of this.clients) {
			try {
				client.write(line);
			} catch {
				this.clients.delete(client);
			}
		}
	}

	async start(port: number): Promise<void> {
		// Watch the mailbox Change Stream for real-time message display.
		void this.watchMailbox();

		await new Promise<void>((resolve, reject) => {
			this.server.listen(port, "0.0.0.0", () => resolve());
			this.server.once("error", reject);
		});
		console.log(`[monitor] Dashboard: http://localhost:${port}`);
	}

	stop(): void {
		this.server.close();
		for (const client of this.clients) {
			try {
				client.end();
			} catch {}
		}
	}

	// ── Request handler ───────────────────────────────────────────────────────

	private async handleRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = req.url?.split("?")[0] ?? "/";
		res.setHeader("Access-Control-Allow-Origin", "*");

		if (url === "/" || url === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(this.buildHtml());
			return;
		}

		if (url === "/events" && req.method === "GET") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write("retry: 3000\n\n");
			// Send current status immediately so the page shows data on first load.
			res.write(
				`event: status\ndata: ${JSON.stringify(this.statusPayload())}\n\n`,
			);
			this.clients.add(res);
			req.on("close", () => this.clients.delete(res));
			return;
		}

		if (url === "/status" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(this.statusPayload()));
			return;
		}

		if (url === "/stop" && req.method === "POST") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			console.log("[monitor] Stop requested via dashboard");
			this.push("shutdown", { reason: "operator-stop" });
			this.onStop();
			return;
		}

		res.writeHead(404).end();
	}

	// ── Mailbox watcher ───────────────────────────────────────────────────────

	private async watchMailbox(): Promise<void> {
		const col = this.db.collection("mailbox");
		try {
			const stream = col.watch(
				[
					{
						$match: {
							operationType: "insert",
							"fullDocument.missionId": this.missionId,
						},
					},
				],
				{ fullDocument: "updateLookup" },
			);
			stream.on("change", (change) => {
				if (change.operationType !== "insert") return;
				const doc = change.fullDocument as {
					_id: unknown;
					from: string;
					to: string[];
					subject: string;
					body: string;
					timestamp?: Date;
				};
				const payload: MailboxMsgPayload = {
					id: String(doc._id),
					from: doc.from,
					to: doc.to,
					subject: doc.subject,
					bodyPreview:
						doc.body.length > 300 ? `${doc.body.slice(0, 300)}…` : doc.body,
					timestamp: (doc.timestamp ?? new Date()).toISOString(),
				};
				this.push("mailbox-msg", payload);
				// Also refresh the status overlay so costs stay current.
				this.push("status" as MonitorEventType, this.statusPayload());
			});
			stream.on("error", (e) =>
				console.error("[monitor] Mailbox watch error:", e.message),
			);
		} catch (e) {
			console.error("[monitor] Could not open mailbox Change Stream:", e);
		}
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private statusPayload() {
		const uptimeSec = Math.floor(
			(Date.now() - this.startedAt.getTime()) / 1000,
		);
		return {
			missionId: this.missionId,
			missionName: this.missionName,
			model: this.model,
			uptimeSec,
			missionTotalUsd: this.accumulator.totalCostUsd(),
			maxCostUsd: this.maxCostUsd,
			agents: this.accumulator.agents().map((a) => ({
				agentId: a.agentId,
				input: a.input,
				output: a.output,
				cacheRead: a.cacheRead,
				llmCalls: a.llmCalls,
				costUsd: a.costUsd,
			})),
		};
	}

	// ── HTML dashboard ────────────────────────────────────────────────────────

	private buildHtml(): string {
		return (
			/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MAGI Monitor</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --red: #f85149; --green: #3fb950; --yellow: #d29922;
    --c-lead: #58a6ff; --c-economist: #3fb950; --c-junior: #e3b341;
    --c-data: #bc8cff; --c-scheduler: #8b949e; --c-user: #ffa657;
  }
  body { background: var(--bg); color: var(--text); font: 13px/1.5 "SF Mono","Fira Code",monospace;
         height: 100vh; display: flex; flex-direction: column; overflow: hidden; }

  /* ── Header ── */
  header { background: var(--surface); border-bottom: 1px solid var(--border);
            padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
  .mission-name { font-size: 15px; font-weight: 600; color: var(--accent); }
  .meta { color: var(--muted); font-size: 11px; }
  .cost { font-size: 13px; font-weight: 600; }
  .cost.warn { color: var(--yellow); }
  .cost.danger { color: var(--red); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:.5 } }
  .spacer { flex: 1; }
  .uptime { color: var(--muted); font-size: 11px; }
  button.stop { background: var(--red); color: #fff; border: none; border-radius: 6px;
                padding: 6px 16px; font: 13px/1 monospace; cursor: pointer; font-weight: 600; }
  button.stop:hover { opacity: .85; }
  button.stop:disabled { opacity: .4; cursor: default; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--green);
         margin-right:6px; animation: blink 2s infinite; }
  .dot.dead { background:var(--red); animation:none; }
  @keyframes blink { 0%,100%{opacity:1}50%{opacity:.3} }

  /* ── Layout ── */
  main { display: flex; flex: 1; overflow: hidden; }

  /* ── Messages ── */
  .messages-pane { flex: 1; overflow-y: auto; padding: 12px; display: flex;
                   flex-direction: column; gap: 8px; }
  .msg { background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
         padding: 10px 12px; border-left: 3px solid var(--border); }
  .msg-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
  .msg-from { font-weight: 600; font-size: 12px; }
  .msg-arrow { color: var(--muted); font-size: 11px; }
  .msg-to { color: var(--muted); font-size: 11px; }
  .msg-time { color: var(--muted); font-size: 10px; margin-left: auto; }
  .msg-subject { font-size: 12px; color: var(--text); font-weight: 500; margin-bottom: 2px; }
  .msg-body { font-size: 11px; color: var(--muted); white-space: pre-wrap; word-break: break-word; }

  /* Agent colours */
  .from-lead-analyst     { border-left-color: var(--c-lead);      }
  .from-economist        { border-left-color: var(--c-economist);  }
  .from-junior-analyst   { border-left-color: var(--c-junior);     }
  .from-data-scientist   { border-left-color: var(--c-data);       }
  .from-scheduler        { border-left-color: var(--c-scheduler);  }
  .from-user             { border-left-color: var(--c-user);       }
  .name-lead-analyst     { color: var(--c-lead);     }
  .name-economist        { color: var(--c-economist);}
  .name-junior-analyst   { color: var(--c-junior);   }
  .name-data-scientist   { color: var(--c-data);     }
  .name-scheduler        { color: var(--c-scheduler);}
  .name-user             { color: var(--c-user);     }

  /* ── Usage pane ── */
  .usage-pane { width: 320px; border-left: 1px solid var(--border); overflow-y: auto;
                padding: 12px; flex-shrink: 0; }
  .usage-pane h3 { font-size: 11px; text-transform: uppercase; color: var(--muted);
                   letter-spacing: .08em; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { color: var(--muted); text-align: right; padding: 3px 6px; font-weight: normal;
       border-bottom: 1px solid var(--border); }
  th:first-child { text-align: left; }
  td { padding: 4px 6px; text-align: right; border-bottom: 1px solid #21262d; }
  td:first-child { text-align: left; }
  tr.total-row td { border-top: 1px solid var(--border); color: var(--accent);
                    font-weight: 600; padding-top: 6px; }
  .pct-bar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 2px; }
  .pct-fill { height: 100%; border-radius: 2px; background: var(--accent);
              transition: width .3s; }

  /* ── LLM call log ── */
  .llm-log { border-top: 1px solid var(--border); padding: 8px 12px; max-height: 160px;
             overflow-y: auto; flex-shrink: 0; background: var(--surface); }
  .llm-log h3 { font-size: 10px; text-transform: uppercase; color: var(--muted);
                letter-spacing: .08em; margin-bottom: 6px; }
  .llm-entry { font-size: 10px; color: var(--muted); padding: 1px 0; }
  .llm-entry .agent { font-weight: 600; }

  .empty { color: var(--muted); font-size: 11px; padding: 20px; text-align: center; }
</style>
</head>
<body>

<header>
  <span class="dot" id="dot"></span>
  <span class="mission-name" id="mission-name">MAGI</span>
  <span class="meta" id="meta"></span>
  <span class="spacer"></span>
  <span class="cost" id="cost-display">$0.0000</span>
  <span class="uptime" id="uptime"></span>
  <button class="stop" id="stop-btn" onclick="stopDaemon()">■ Stop daemon</button>
</header>

<main>
  <div class="messages-pane" id="messages">
    <div class="empty" id="empty-msg">Waiting for messages…</div>
  </div>

  <div class="usage-pane">
    <h3>Token usage</h3>
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>In</th>
          <th>Out</th>
          <th>Cache</th>
          <th>Calls</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody id="usage-tbody">
        <tr><td colspan="6" style="color:var(--muted);text-align:center;padding:12px">No data yet</td></tr>
      </tbody>
    </table>
    <div id="cost-limit-bar" style="margin-top:12px;display:none">
      <div style="font-size:10px;color:var(--muted);margin-bottom:3px">
        Spending cap: <span id="cap-amount"></span>
      </div>
      <div class="pct-bar"><div class="pct-fill" id="cap-fill" style="width:0%"></div></div>
    </div>

    <div class="llm-log" style="margin-top:12px;border-top:none">
      <h3>LLM calls</h3>
      <div id="llm-entries"><span style="color:var(--muted);font-size:10px">No calls yet</span></div>
    </div>
  </div>
</main>

<script>
const es = new EventSource('/events');
let startedAt = Date.now();
let maxCostUsd = null;
let missionTotalUsd = 0;
let stopped = false;

es.onopen = () => { document.getElementById('dot').classList.remove('dead'); };
es.onerror = () => { document.getElementById('dot').classList.add('dead'); };

es.addEventListener('status', e => {
  const s = JSON.parse(e.data);
  document.getElementById('mission-name').textContent = s.missionName || s.missionId;
  document.getElementById('meta').textContent = s.model;
  startedAt = Date.now() - s.uptimeSec * 1000;
  maxCostUsd = s.maxCostUsd;
  missionTotalUsd = s.missionTotalUsd;
  updateCostDisplay(s.missionTotalUsd, s.maxCostUsd);
  renderUsageTable(s.agents, s.missionTotalUsd, s.maxCostUsd);
});

es.addEventListener('mailbox-msg', e => {
  const m = JSON.parse(e.data);
  addMessage(m);
});

es.addEventListener('llm-call', e => {
  const d = JSON.parse(e.data);
  missionTotalUsd = d.missionTotalUsd;
  updateCostDisplay(d.missionTotalUsd, maxCostUsd);
  addLlmEntry(d);
});

es.addEventListener('shutdown', e => {
  const d = JSON.parse(e.data);
  document.getElementById('dot').classList.add('dead');
  document.getElementById('stop-btn').disabled = true;
  document.getElementById('stop-btn').textContent = '— stopped';
  addSystemMsg('Daemon stopped: ' + (d.reason || 'unknown'));
  stopped = true;
});

es.addEventListener('cost-limit', e => {
  addSystemMsg('⚠ Cost limit reached — daemon aborting');
  document.getElementById('cost-display').classList.add('danger');
});

function updateCostDisplay(total, max) {
  const el = document.getElementById('cost-display');
  el.textContent = '$' + total.toFixed(4);
  el.className = 'cost';
  if (max && total > max * 0.8) el.classList.add('warn');
  if (max && total >= max) el.classList.add('danger');
}

function renderUsageTable(agents, total, max) {
  if (!agents || agents.length === 0) return;
  const tbody = document.getElementById('usage-tbody');
  const agentRows = agents.map(a => \`
    <tr>
      <td><span class="name-\${a.agentId}">\${a.agentId}</span></td>
      <td>\${fmt(a.input)}</td>
      <td>\${fmt(a.output)}</td>
      <td>\${fmt(a.cacheRead)}</td>
      <td>\${a.llmCalls}</td>
      <td>$\${a.costUsd.toFixed(4)}</td>
    </tr>\`).join('');
  tbody.innerHTML = agentRows + \`
    <tr class="total-row">
      <td>TOTAL</td><td></td><td></td><td></td><td></td>
      <td>$\${total.toFixed(4)}</td>
    </tr>\`;

  if (max) {
    document.getElementById('cost-limit-bar').style.display = 'block';
    document.getElementById('cap-amount').textContent = '$' + max.toFixed(2);
    const pct = Math.min(100, (total / max) * 100);
    const fill = document.getElementById('cap-fill');
    fill.style.width = pct + '%';
    fill.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--accent)';
  }
}

function addMessage(m) {
  document.getElementById('empty-msg')?.remove();
  const pane = document.getElementById('messages');
  const toStr = m.to.join(', ');
  const div = document.createElement('div');
  div.className = \`msg from-\${m.from}\`;
  div.innerHTML = \`
    <div class="msg-header">
      <span class="msg-from name-\${m.from}">\${m.from}</span>
      <span class="msg-arrow">→</span>
      <span class="msg-to">\${toStr}</span>
      <span class="msg-time">\${fmtTime(m.timestamp)}</span>
    </div>
    <div class="msg-subject">\${esc(m.subject)}</div>
    <div class="msg-body">\${esc(m.bodyPreview)}</div>\`;
  pane.appendChild(div);
  pane.scrollTop = pane.scrollHeight;
}

function addSystemMsg(text) {
  document.getElementById('empty-msg')?.remove();
  const pane = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg';
  div.style.borderLeftColor = 'var(--muted)';
  div.innerHTML = \`<div class="msg-body" style="color:var(--muted)">\${esc(text)}</div>\`;
  pane.appendChild(div);
  pane.scrollTop = pane.scrollHeight;
}

function addLlmEntry(d) {
  const container = document.getElementById('llm-entries');
  if (container.children[0]?.tagName === 'SPAN') container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'llm-entry';
  div.innerHTML = \`<span class="agent name-\${d.agentId}">\${d.agentId}</span> ` +
			`in=\${fmt(d.input)} out=\${fmt(d.output)}\${d.cacheRead > 0 ? ' cache='+fmt(d.cacheRead) : ''} ` +
			`$\${d.callCostUsd.toFixed(4)} [mission $\${d.missionTotalUsd.toFixed(4)}]\`;
  container.insertBefore(div, container.firstChild);
  if (container.children.length > 50) container.lastChild.remove();
}

function stopDaemon() {
  if (stopped) return;
  if (!confirm('Stop the MAGI daemon? This will abort the current mission cycle.')) return;
  fetch('/stop', { method: 'POST' }).catch(() => {});
  document.getElementById('stop-btn').disabled = true;
  document.getElementById('stop-btn').textContent = 'Stopping…';
}

function fmt(n) { return n.toLocaleString(); }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

// Update uptime counter every second.
setInterval(() => {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  document.getElementById('uptime').textContent =
    h > 0 ? \`\${h}h \${m}m\` : m > 0 ? \`\${m}m \${s}s\` : \`\${s}s\`;
}, 1000);
</script>
</body>
</html>`
		);
	}
}
