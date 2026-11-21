# ADR-0037: Interactive apps on the mission machine, served from a separate apps host

**Status:** Implemented on dev (2026-11-21, slices a–g; first app opened live on `houseplant-grand-hotel`); accepted 2026-11-21; proposed 2026-11-20. Reviewed by appsec on 2026-11-20 (approved with conditions,
folded in below). Product owner's decisions of 2026-11-21 folded in: Gradio rather than
Streamlit, declaration by request files, three kinds, records in `missionApps`. Spike done
2026-11-21 ("Spike results"); an origin per app decided after it.
**Relates to:** issue #42; the catalog's planned entity `app`, operations `app.*`, journeys
J-22 and A-10, invariants `app.loopback-only`, `app.as-owner`, `app.bounded` and
`sec.served-apart`; ADR-0033 (jobs run as their author); F-042 (the monitor server is reachable
over the private network); TB-20 (sandboxed HTML previews); ADR-0031 (machine upgrades)

## Context

The operator wants to use, in a browser, programs that the mission's agents write and run on
the mission machine. Three cases matter:

1. **A notebook the operator and an agent work on together.** The agent writes and edits a
   Jupyter notebook; the operator opens it, runs cells, changes them; the agent sees the
   results and continues.
2. **A data app.** An agent writes a small app with controls and charts (for example, to show
   how a weather model behaves); the operator uses it. One framework is enough.
3. **A small interactive website**, for one user: static pages, perhaps a little JavaScript
   and a few endpoints, built by an agent and served by the platform.

Facts that shape the design:

- **Nothing on the mission machine is reachable from outside except the monitor server**
  (port 4000), through the control plane's proxy. Neither that proxy nor the monitor server
  carries WebSockets today. JupyterLab needs them, and Gradio may use them.
- **An app runs code an agent wrote,** in the operator's browser as well as on the machine. A
  prompt-injected agent could write a hostile app, so the design must hold if the app is
  hostile.
- **Served from the cockpit's address, an app would act as the operator.** Its JavaScript could
  call the cockpit's API with the operator's session: launch missions, confirm copilot
  actions, read every file.
- **There is no domain of our own**, so no wildcard hostnames (`<mission>.apps.example.com`).
  Each Fly app has exactly one name, `<app>.fly.dev`.
- **`fly.dev` is on the public suffix list.** Two Fly apps are therefore two different *sites*
  to a browser, not just two origins, and the cockpit's `SameSite=Strict` session cookie is
  never sent with a request made from another Fly app's pages.
- **Loopback is shared by every OS user on the machine.** An app listening on `127.0.0.1` can
  be reached by every agent of the mission, not only its owner. For Jupyter, that would let one
  agent run code as another, which defeats the per-agent OS isolation.
- **Mission machines are not reachable from the internet** (checked 2026-11-21: the missions
  apps have no public IPs, and no machine declares a public service). **They do not filter
  inbound private-network traffic** (to be confirmed, see "Before building"). A server that
  listens on all interfaces may be reachable from every other machine in our Fly organization,
  other tenants' missions included. Many servers listen on all interfaces by default, and an
  agent can start one today with Bash.
- **Background jobs are batch work,** killed after 30 minutes (`job-runner.ts`). An app must
  keep running, so it needs its own lifecycle.

## Decision

### 1. Apps are served from a separate Fly app, the apps host

A small new Fly app, `magi-apps-<suffix>` (for dev, `magi-apps-dev.fly.dev`), serves every app,
of every mission. It is a separate site from the cockpit, so an app's scripts never carry or
reach the cockpit's session (`sec.served-apart`, first half).

It holds none of the cockpit's secrets: no database credentials, no Fly API token, no Firebase
key, no monitor signing key. It holds two keys of its own (decision 3), and it is stateless: all
it needs to route a request is in the request's signed cookie. Fly can stop it when idle and
start it on the next request. It runs a single machine, so that a ticket's single use can be
kept in memory.

### 2. One app cannot reach another's: an origin per app, and a secret in its path

Each running app gets its **own origin**: a port on the apps host
(`https://magi-apps-dev.fly.dev:200NN/`, decided 2026-11-21 after the spike). A browser keeps
origins apart, so one app's scripts cannot read another's storage (`localStorage`, IndexedDB,
the Cache API) or script its windows, whatever either app does. Cookies are the exception:
they ignore ports, so the rules below still keep them apart.

- **Slots.** The apps host listens on 100 public ports, 20000–20099 (a Fly port range with TLS,
  checked in the spike). Fly tells it the port of each request in `Fly-Forwarded-Port`, which
  Fly overwrites; `X-Forwarded-Port` is passed through from the client and is never read. The
  control plane assigns each app a slot when it is first opened and keeps it for that app:
  two fields of the app's record, `slot` and `slotUsedAt` (when a ticket was last issued),
  with a unique index on `slot` across all missions, so no two apps can hold one slot. A slot
  passes to another app only when its holder has been removed (deleting the record frees it),
  or not opened for longer than a session lasts (12 hours), so no live session of the old
  holder can share the origin with the new one. When all slots are held, opening one more app
  is refused with that reason.
- **Leftovers are cleared.** Redeeming a ticket answers with `Clear-Site-Data: "storage"` for
  that slot's origin, so nothing a previous holder left in this browser survives. The cost:
  an app's own browser storage does not outlive a new Open (JupyterLab forgets its layout).
- **Each app also gets a capability:** a random 128-bit value, made by the daemon when the app
  is declared, kept in the app's record (`missionApps`, decision 6), and never shown to agents.
  The app is served at `https://magi-apps-dev.fly.dev:<slot>/a/<capability>/`, which is also
  its `$BASE_PATH`.
- **Each request needs** the capability in its path, an app-session cookie for that same
  capability (decision 3), and the slot the session names. A request whose port is not its
  session's slot is refused: a script cannot use another app's cookie from its own origin.
- **Requests from another app's origin are refused.** Ports of one host are the same *site*, so
  the browser sends cookies between them. The apps host refuses any request with
  `Sec-Fetch-Site: same-site` (another port of the apps host) and any request without
  `Sec-Fetch-Site` (every supported browser sends it), and accepts `same-origin` and `none`
  (typed or bookmarked). The ticket's redemption also accepts `cross-site` (it comes from the
  cockpit) and does nothing but set the session.
- **The apps host rewrites every `Set-Cookie`** from an app to `Path=/a/<capability>/`, with no
  `Domain`, so a script sees only its own app's cookies.
- **No service worker can escape its app:** the apps host removes `Service-Worker-Allowed`.
- **Every response gets** `Referrer-Policy: no-referrer` (the capability never leaks to another
  site), `Cross-Origin-Opener-Policy: same-origin`, `Content-Security-Policy:
  frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and
  `Cross-Origin-Resource-Policy: same-origin`.

**Residual risk:** with an origin per app, an app's storage is its own. What is left is the
browser's per-site state shared by the ports (cookies, which the rules above scope and check)
and the operator's own clicks: a link in one app that the operator follows to another app's
URL is a navigation from another origin (`same-site`) and is refused, so the operator opens
apps from the cockpit. Gradio's run history stays off (`GRADIO_RUN_HISTORY=False`): it keeps
every call's inputs and outputs in the browser, which an operator may not expect.

### 3. Opening an app: a ticket from the cockpit, then the apps host's own sign-in

1. The operator clicks **Open** in the mission cockpit's Apps tab. The cockpit calls the
   control plane: `POST /api/missions/:id/apps/:name/open`.
2. The control plane checks that the caller owns the mission, the same check as every mission
   route. If the app is stopped, it asks the mission machine to start it, within the limit on
   apps running at once (`app.open`).
3. It returns a URL on the apps host carrying a **ticket**. The ticket is signed with
   `APPS_TICKET_KEY`, valid for 60 seconds, and used once. It names the user, the mission, the
   app, the capability and the mission machine's private address.
4. The apps host checks the ticket. It sets the app-session cookie: `HttpOnly`, `Secure`,
   `SameSite=Strict`, `Path=/a/<capability>/`, signed, lasting at most 12 hours, and naming
   the same fields as the ticket. It then redirects to the app.
5. **A copied URL** is `https://<apps host>:<slot>/a/<capability>/`. In another tab of the same browser the cookie is
   there, and it works. Anywhere else, or after the cookie has expired, the apps host redirects
   to the cockpit page `/?openApp=<capability>`. That navigation comes from another site, so
   the cockpit's `SameSite=Strict` cookie is not sent with it, but the page itself needs none:
   it signs the operator in as usual, then calls `POST /api/apps/reopen` with the capability,
   on the same site, cookie included. The control plane finds the app by its capability,
   checks that the caller owns its mission, and returns a new ticket. Anyone else gets "not
   found".

Sessions are signed and stateless: the apps host has no database, by design, so it cannot
look up ownership on each request. Missions have no change of owner today. If one is added, it
must replace the mission's app capabilities, which ends every session bound to them. An app on
a suspended mission is not reachable at all, because its machine is down. The `app.open` rule "checked on every request" is
met by the signed session on every request, WebSocket upgrades included. It is not a fresh
ownership lookup.

### 4. The path from the browser to the app

```
browser ─https─▶ apps host (Fly app) ─6PN─▶ mission machine :4000, monitor server
         cookie + /a/<cap>/…                  /a/<cap>/…, apps token, HTTP and WebSocket
                                              ─▶ 127.0.0.1:$PORT, the app (as its owner's user)
```

- **Apps host to monitor server:** over the private network, with a per-mission **apps token**.
  The token is derived from `APPS_SIGNING_KEY` the same way the monitor token is derived. The
  control plane injects it into the machine at creation, as it does `MONITOR_TOKEN`. The monitor
  server accepts it on `/a/*` only (the path the browser sees, so JupyterLab gets it unchanged; `/apps` is the cockpit's list and controls, behind the monitor token), and accepts nothing else there. The cockpit's monitor
  token does not open apps, and the apps token opens nothing else.
- **Monitor server to app:** a new route forwards HTTP and WebSocket upgrades to the app's
  loopback port. It records when each app was last opened, for the idle stop. Whether the
  path prefix is kept depends on the kind (decision 7): JupyterLab serves under its base URL
  and gets the full path; Gradio and the site script serve at `/` and get the path with the
  prefix removed, as Gradio's guide for running behind a proxy describes.
- **WebSockets** are carried at every hop. That is new code in the monitor server and in the
  apps host. The control plane's existing proxy is not involved. The apps host refuses an
  upgrade whose `Origin` is not the slot's own origin (scheme, host and port), so another
  app's port is refused as well as another site.
- **The machine checks that the request is for its own mission.** The apps host names the
  mission from the session in each forwarded request. The monitor server refuses a request whose
  mission is not its own `MISSION_ID`, as well as one whose apps token or capability it does not
  know. Reaching the right machine therefore does not rest on the address alone.
- **A stale address sends the operator back for a new ticket.** The machine's private address
  is copied into the session when the app is opened, but it changes when the machine is
  recreated (a resume onto a new machine, a crash). When the machine cannot be reached, or
  refuses the mission, token or capability, the apps host does what it does for an expired
  session: it redirects to the mission cockpit, which issues a new ticket with the current
  address. A request that lands on another mission's machine is refused there, never served.

### 5. Apps listen only where they should

Two network rules on the mission machine, set by the platform, not left to agents:

- **Inbound from the private network: deny all, except the monitor server's port and Fly's
  SSH (22).** This
  closes the exposure described in Context for apps and for anything an agent starts with
  Bash. It enforces `app.loopback-only` whatever address an app binds to.
- **Loopback app ports: only the daemon, and the app's owner.** When the daemon starts an app,
  it allows connections to that port from its own user (the monitor server's hop) and from the
  app's owner, so the agent can test its own app. Every other OS user is refused, so other
  agents cannot reach the app. This takes a firewall rule keyed on the connecting user
  (nftables' `meta skuid`; iptables' owner match is not available on Fly's kernel).
- **A port's rule lives exactly as long as its app.** Ports are reused, so a rule left behind
  would let the previous owner reach the next app on that port. The daemon revokes the rule
  whenever the app's process ends (stop, crash, removal), before the port is handed out again;
  `allow` replaces whatever rule the port had; `init`, at every boot (a restart resets the
  rules), removes every rule in the range.

The daemon runs as `magi-operator`, not root (the image switches user before starting it), so
both rules go through one new `sudo` rule. It allows a single fixed helper,
`/usr/local/sbin/magi-net init|allow <port> <uid>|revoke <port> <uid>`. The helper accepts only
a port in the apps range and the uid of a member of the agents' group (`magi-shared`), never
root or the daemon's own user, and sets nothing else. It is a new
boundary in the threat model.

Jupyter's own token stays on as a second layer: the daemon generates it, the monitor server's
hop adds it (`Authorization: token …`), and the browser never sees it.

### 6. Declaring and running apps: request files, and the daemon as supervisor

**Declaring an app** works like submitting a job. The `serve-app` skill's script writes a
request file into `shared/apps/requests/`: `{id, action: declare | start | stop | remove, name,
kind, path, handlers, description}`. The daemon reads the directory every 5 seconds. The
request's owner is the file's owner, established by the same checks as for jobs and schedules
(ADR-0033: no symlink, no hard link, not the daemon's, an agent of this mission). The request
is checked field by field: the name is a slug, the kind one of three, the path resolved inside
the owner's workdir or `shared/`. An agent acts on its own apps only; the mission copilot on
any. Re-declaring one's own app replaces it; another agent's app is refused.

The daemon answers in `shared/apps/status/<name>.json` (read-only to agents, without the
capability), naming the request it answers. The script writes its request atomically, waits
for that answer, and prints the app's state, or the error with the last lines of its log. The
agent gets its answer in the same command, as a tool would give it, without a new tool.

**The record:** each app is a document in `missionApps`, keyed by mission and name, written
only by the supervisor: owner, kind, path, capability, state, port, restarts, when it was last
opened. The control plane reads it to open an app; the cockpit lists it.

**Running an app** (`app.run`, the daemon's new `mm-apps` component):

- **Starting:** `sudo -u <owner>` through a new wrapper, `/usr/local/bin/magi-app`, in its own
  process group, with a minimal environment and no secrets: `PATH`, `HOME`, `PORT`,
  `BASE_PATH`, the kind's settings, and the Jupyter token. The token goes in the environment,
  never on the command line, which every user can read in `/proc`. The daemon builds the
  command line for the kind (decision 7); an agent never supplies one. The port comes from a
  reserved loopback range, 20000–20099.
- **Watching:**
  - the daemon is told at once when the process exits;
  - it checks every 15 seconds that the port answers;
  - the first answer moves `starting` to `running`;
  - no answer within 2 minutes of a start, or 4 missed checks in a row, counts as a crash.

  A crash means a restart, at most 3 an hour; past that the app is `failed`, and its owner is
  told by message, with the last lines of its log.
- **Stopping:** `SIGTERM` to the process group, then `SIGKILL` after 10 seconds. An app stops
  when:
  - the mission is suspended;
  - it has been unopened for 4 hours (a mission setting);
  - someone stops it;
  - its declaration is removed.

  At daemon boot, every app left over from before is killed and marked `stopped`. Nothing
  restarts by itself.
- **The limit:** at most 3 apps of a mission run at once (a mission setting). A start beyond it
  is refused, and the refusal names the apps running.
- **Logs:** each app's output goes to a file in its owner's workdir, which the owner can read.
- **Resources:** `app.status` shows each app's memory. A notebook with a large
  dataframe needs a bigger machine, through the existing upgrade path (ADR-0031). No
  per-app memory limit in this version.

### 7. What the platform supports, and what agents are taught

The mission image ships three ways to serve, and a new platform skill, **`serve-app`**, teaches
them:

| Case | Supported | How it runs under `$PORT` and `$BASE_PATH` |
|---|---|---|
| Notebook with the operator | JupyterLab, with real-time collaboration (`jupyter-collaboration`) | `jupyter lab --ServerApp.ip=127.0.0.1 --ServerApp.port=$PORT --ServerApp.base_url=$BASE_PATH`, terminals disabled |
| Data app | **Gradio** | `python <file>` with `GRADIO_SERVER_NAME=127.0.0.1`, `GRADIO_SERVER_PORT=$PORT`, `GRADIO_ROOT_PATH=$BASE_PATH`, `GRADIO_ANALYTICS_ENABLED=False`; the prefix is removed before the request reaches it |
| Small website | Static files, plus a few endpoints if needed | a platform script, `serve-site`, that serves a folder at `/` (prefix removed), plus optional handlers from a Python file |

These are the only three **kinds** an agent can declare (`jupyter`, `gradio`, `site`). The
platform builds each command line, so binding to loopback and the base path hold by
construction; a new kind is a new recipe here.

**Gradio rather than Streamlit** (product owner, 2026-11-21): one framework is enough, and
Gradio's settings for a path behind a proxy are documented. Its version is pinned to one the
spike has checked: breakage behind custom domains has been reported from 6.4 on. Gradio can
open a public tunnel of its own (`launch(share=True)`); the skill forbids it, but that is an
instruction, not a control. Closing it, as for any tunnel an agent could start with Bash, needs
an outbound firewall, which belongs with the security-testing work.

**The notebook case:**
- The notebook is a file in the mission's shared folder.
- With real-time collaboration, a change the agent writes to the file is picked up by the
  operator's open notebook. The server polls the disk every second (`file_poll_interval`).
- The operator's edits and outputs are saved to the file within a second
  (`document_save_delay`), where the agent reads them.

Merging an agent's edit with the operator's unsaved edits is not fully solved upstream, so the
skill tells the agent to message the operator before it changes a notebook the operator has
open. The kernel runs as the app's owner: code the operator runs has that agent's file access,
no more.

**The skill teaches:**
- how to declare, check and stop an app;
- the three recipes;
- relative links, since the app lives under a path;
- reading its log;
- telling the operator where to find the app ("open it from the Apps tab").

It also tells agents never to start a server with Bash outside `serve-app`, never to use
Gradio's `share=True`, and never to keep
mission data or the app's own URL in the browser's storage (decision 2).

## Alternatives considered

- **Serve apps from the cockpit's address,** under `/missions/<id>/apps/…`. Rejected: an app's
  scripts would act with the operator's session.
- **A sandboxed iframe in the cockpit,** as for HTML previews (TB-20). Rejected: an opaque
  origin has no cookies and cannot call back to its own server in the usual way. JupyterLab and
  Gradio both break.
- **The control plane on a second port.** Rejected: a different origin but the same site, so
  the cockpit's `SameSite=Strict` cookie would be sent with requests from apps.
- **A hostname per mission or per app.** That would give a separate origin, with separate
  storage, and is the best isolation. It needs a domain of our own with a wildcard record and
  certificate. Deferred until there is a domain.
- **One origin for every app**, with Gradio's run history off and a rule in the skill. Rejected
  after the spike: the only barrier between two apps would be what each app chooses to keep in
  the browser's storage, and Gradio kept its own capability there by default.
- **A tool to declare apps** (`ServeApp`, `ListApps`, `ControlApp`), run in the daemon, which
  knows the caller. Rejected: the owner of a request file is already established safely for
  jobs and schedules, a script can wait for the answer, and a file can be checked as strictly
  as a tool's arguments. One way to hand the platform work, for jobs and apps alike.
- **Any command line an agent chooses**, with `$PORT` and `$BASE_PATH`. Rejected for now: the
  platform could not vouch for the flags (loopback, base path, no tunnel), and the firewall
  would be the only guard. A new kind is added as a recipe instead.
- **Tunnels** (ngrok, localtunnel). Rejected: unauthenticated, through a third party.
- **Exposing app ports on the private network** directly to the apps host. Rejected: apps would
  listen beyond loopback, which is what decision 5 forbids.

## Consequences

- **New pieces:**
  - the apps host (a Fly app, a few dollars a month, stopped when idle), with a public port
    range 20000–20099;
  - two secrets, `APPS_TICKET_KEY` (control plane and apps host) and `APPS_SIGNING_KEY`
    (control plane and apps host; the per-mission token derived from it goes to the machine);
  - a monitor route with WebSocket forwarding;
  - the `mm-apps` supervisor, its request directory and the `missionApps` collection;
  - an Apps tab in the cockpit;
  - the `serve-app` skill;
  - a `sudo` rule and its helper;
  - firewall rules at machine boot;
  - JupyterLab, `jupyter-collaboration` and Gradio in the mission image, which grows it.
- **Threat model:** four new boundaries: the operator's browser and the apps host; the apps
  host and the monitor server; the monitor server and an app on loopback; the daemon and the
  `magi-net` helper. They go into `threat-model.md` and `trust-boundaries.md` before building.
  The private-network rule closes a gap that exists today, independent of apps.
- **If the apps host is compromised,** the attacker holds both keys. It can forge sessions and
  apps tokens for any mission, and so reach any app whose capability it learns. Capabilities are
  never stored on the apps host; it sees them only in the requests passing through it, so the
  exposure is the apps used while it is compromised. It reaches nothing of the cockpit: no
  session, no database, no mission data beyond those apps. On suspicion, rotate
  `APPS_TICKET_KEY` and `APPS_SIGNING_KEY` (every session ends) and have the daemons replace
  their apps' capabilities.
- **Resilience:** new failure modes for the resilience document:
  - an app that eats the machine's memory (the daemon is on the same machine);
  - the apps host down (the cockpit shows the app as running, but Open fails);
  - a daemon restart (every app stops).
- **Catalog** (approved 2026-11-21):
  - the `app` entity is stored in `missionApps`, written only by `mm-apps`;
  - `app.declare` names the request directory and says the platform builds the command line;
  - `app.run`'s loopback rule is enforced by the firewall rather than by detecting and stopping
    an app;
  - `app.open` reads "checked when the app is opened, then by a signed session of at most 12
    hours on every request, WebSockets included";
  - `missionApps` is also written by `cp-apps`, for two fields only: the app's port on the
    apps host and when it was last opened (approved 2026-11-21, rather than a second
    collection);
  - the components `mm-apps`, `cp-apps` and `ui-apps` get their paths when built, with
    `cp-apps` being the new apps host.

## Before building

1. **Confirm the private-network exposure:** from one mission machine, try to reach a test
   server listening on all interfaces on another. If it is reachable, record it as a security
   finding and fix it first, whatever happens to this ADR.
2. **Confirm the firewall can be set:** that `iptables` with the owner match works on a Fly
   machine (a full VM, so root has the network capability), when the `magi-net` helper runs
   through `sudo`.
3. **A spike, through both hops,** with WebSockets and a path prefix:
   - JupyterLab with collaboration;
   - Gradio, with the prefix removed;
   - a static site.

   Measure the image's growth and the memory each needs. Check what JupyterLab and Gradio
   write to origin storage, and whether any of it contains the app's path.
4. **A cross-site WebSocket upgrade is refused** at the apps host.
5. **A hostile app,** kept as a test: from its page it tries to call the cockpit's API, read
   another app's storage, load another app's path, and register a service worker outside its
   own path; on the machine it tries to listen beyond loopback and to connect to another
   agent's app port. Each must fail.

## Spike results (2026-11-21)

Run locally (JupyterLab 4.6.6, `jupyter-collaboration` 5.0.4, Gradio 6.32.0, a static site;
a two-hop prototype on `http-proxy-middleware` 4.2.0; Chromium through Playwright) and on a
throwaway Fly app (`magi-spike-apps`, two machines from the mission image
`magi-missions-dev:c0d1b36`, Debian 12, Python 3.11, kernel 6.12-fly).

**Through both hops, all three kinds work.** A notebook cell ran over the kernel's WebSocket
(output `42`) with collaboration's WebSockets connected; the Gradio app answered with the
prefix removed (`GRADIO_ROOT_PATH`); the site's relative links resolved under the path.

**Changes the spike forces:**
- **The firewall uses nftables, not iptables.** Fly's kernel lacks the iptables owner match
  ("Extension owner revision 0 not supported"); nftables' `meta skuid` works: on loopback, the
  owner and the daemon's user reached the app's port, another agent and root were refused.
  The inbound rule worked as designed: a server an agent started on all interfaces answered
  another machine before the rule (recorded as F-081) and not after; the monitor port still
  answered; DNS (including `.internal` names) and outbound HTTPS still worked.
- **The inbound rule also allows Fly's SSH (port 22).** Without it, `fly ssh console` to a
  mission machine stops working. Fly authenticates those sessions with organization
  certificates.
- **Rules and installed packages do not survive a machine restart** (the root filesystem is
  reset). `nftables` and the helper are in the image; `init` runs at every boot, before any app.
- **One upgrade handler per server, and the path rewritten explicitly.** With `ws: true`,
  each `http-proxy-middleware` instance subscribes itself to the server's `upgrade` event
  after its first request, with a filter that matches everything, so several app proxies
  answered each WebSocket and it dropped within seconds. The monitor route and the apps host
  set `ws: false`, call `upgrade` from their own single handler, and rewrite `req.url`
  themselves; the library did not apply `pathRewrite` to upgrades at the second hop.
- **Gradio stores its own path, capability included, in `localStorage`:** its "run history"
  keeps the page path and every call's inputs and outputs. `GRADIO_RUN_HISTORY=False` turns it
  off, and with it set no capability was found in any storage of the three kinds (JupyterLab
  keeps only UI state and an anonymous collaborator name). An app's own code can still turn
  it back on, so this is a default, not a guarantee: see the open choice below.
- **The ticket is redeemed by a page, not a redirect.** A `SameSite=Strict` cookie set during a
  redirect chain that began on another site (the cockpit) is not sent with the redirected
  request. The apps host answers the ticket with a small page that sets the session and moves
  to the app on the same site. (Design consequence; checked by the build's tests.)

**Sizes:**

| | Memory (local, idle after one use) |
|---|---|
| JupyterLab server, with collaboration | ~130 MB |
| a notebook kernel | ~60 MB |
| a Gradio app | ~165 MB |
| the site script | ~20 MB |

The three packages take ~550 MB installed; the image grows by about that much. On the default
1 GB machine, with the daemon at ~600 MB, one notebook or one Gradio app fits, three do not:
the skill tells agents to ask for a bigger machine (ADR-0031) before serving more than one.

**Decided after the spike (product owner, 2026-11-21): an origin per app**, a port of the apps
host (decision 2). Checked on the throwaway app: a 100-port range (20000–20099) with TLS on the
`fly.dev` certificate; `Fly-Forwarded-Port` gives the port and cannot be forged by a client
(`X-Forwarded-Port` can); a port outside the range is refused.

