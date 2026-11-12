# Security controls checklist

Controls MAGI should have, whether or not anything in the code mentions them. Drawn from OWASP
ASVS, the OWASP Top 10 for LLM applications, OWASP's agentic-AI threats, NIST SSDF and SLSA,
and written for MAGI's own components (control plane, mission daemon, agents, background jobs,
copilots, cockpit, CI). For each row, find where the control is implemented, or record that it
is missing. A missing control is a finding even if no code is wrong.

Verdicts: pass · fail · missing · n/a · unverifiable — each with evidence (file:line, command
output, or where you looked). Work with `checklist.py` (working-agreements).

| Id | Area | Control to check | Verdict | Evidence |
|---|---|---|---|---|
| SC-01 | Architecture | Every process, port, socket, OS identity and external service in the code appears in the threat model with its trust boundary | ? | |
| SC-02 | Architecture | Every privileged operation lists who can write its inputs and the guard that makes that safe (`trust-boundaries.md`) | ? | |
| SC-03 | Architecture | Each process holds only the secrets it needs: control plane, daemon, agent subprocesses (none), background jobs (scoped token only), copilots (none in Bash) | ? | |
| SC-04 | Architecture | Security checks fail closed: an error, a timeout or an unknown value denies rather than allows | ? | |
| SC-05 | Authentication | Every network route requires authentication (control plane, monitor server incl. GET and SSE, Tool API), except an explicit, short public list | ? | |
| SC-06 | Authentication | Tokens are unguessable, scoped to one purpose, compared in constant time, and expire or can be revoked | ? | |
| SC-07 | Authentication | Repeated authentication failures are rate-limited | ? | |
| SC-08 | Authentication | The session cookie is HttpOnly, Secure and SameSite; sign-out invalidates it; no credential travels in a URL or sits in browser storage | ? | |
| SC-09 | Authentication | Use of the break-glass admin key is logged and visible to the operator | ? | |
| SC-10 | Access control | Every query on mission or user data is scoped server-side by owner (`userId`, `missionId`), never by a scope the client sends | ? | |
| SC-11 | Access control | Every route or tool that takes an id checks that the caller owns that object (no IDOR) | ? | |
| SC-12 | Access control | An agent can act only inside its own mission and identity: own OS user, private workdir unreadable by others, shared folder by ACL | ? | |
| SC-13 | Access control | Any copilot action outside its sandbox needs operator confirmation; the card shows the validated payload; it is re-validated at execution | ? | |
| SC-14 | Access control | No LLM can approve its own request or raise its own cap, ceiling or limits | ? | |
| SC-15 | Input | Every external input is validated against a schema where it enters: API bodies, tool arguments, team config, files the daemon reads from agent-writable folders | ? | |
| SC-16 | Input | Every path built from input is contained after resolving symlinks, and opened without following links | ? | |
| SC-17 | Input | No subprocess gets a shell string built from input; argv arrays, fixed executable paths, minimal environment | ? | |
| SC-18 | Input | Database queries take input only as values, never as operators or field names | ? | |
| SC-19 | Output | Everything rendered in the cockpit is escaped; agent HTML and SVG are sandboxed; the CSP is enforcing in deployment | ? | |
| SC-20 | Input | Every outbound HTTP request built from input is checked against internal addresses on every redirect hop, with size and time limits | ? | |
| SC-21 | Input | Archives and documents have size, ratio and depth limits, and parsing runs with a timeout | ? | |
| SC-22 | Secrets | No secret in source, images, logs, error messages, prompts, mental maps, or agent and job environments | ? | |
| SC-23 | Secrets | There is an inventory of secrets: holder processes, owner, how to rotate, last rotation | ? | |
| SC-24 | Data | TLS on every network hop; retention defined and enforced for logs, transcripts and call logs | ? | |
| SC-25 | Data | Backups exist and a restore has been rehearsed | ? | |
| SC-26 | Logging | Security events are recorded: authentication failures, admin actions, card confirmations, config and cap changes, privilege use | ? | |
| SC-27 | Logging | Each record says who, what, on what object, and the outcome, without secrets | ? | |
| SC-28 | Monitoring | Alerts exist and reach a person for: repeated auth failures, spend anomalies, unexpected privilege use, a service down | ? | |
| SC-29 | Assurance | Each security control has a test that fails if the control is removed | ? | |
| SC-30 | LLM | Content from the web, documents and teammates is marked untrusted, and no instruction inside it can trigger a privileged action without a guard that does not depend on the model | ? | |
| SC-31 | LLM | Each agent's tools are the minimum for its role; dangerous tools are disabled or gated per agent | ? | |
| SC-32 | LLM | Model output is never executed, rendered or used in a query without the validation that user input gets | ? | |
| SC-33 | LLM | Every LLM-driven loop has a spend cap, a per-turn limit and a timeout: agents, copilots, reflection, research sub-agents, background jobs | ? | |
| SC-34 | LLM | Prompts and mental maps contain no secret, so their leakage is harmless | ? | |
| SC-35 | LLM | Agent memory written from untrusted content (mental maps, summaries, agent-written skills) cannot become policy; agent-written skills are labelled as such | ? | |
| SC-36 | Agents | A message between agents never carries operator authority; no agent can send as `user` or `system` | ? | |
| SC-37 | Agents | The human in the loop is not overwhelmed: confirmations are few, clear about consequences, and cannot be flooded | ? | |
| SC-38 | LLM | Only known models with real prices are accepted; what is sent to providers is acceptable for the data involved | ? | |
| SC-39 | Supply chain | Dependencies come from the lockfile, are audited in CI, and high or critical advisories block; overrides and exceptions carry a reason and an expiry | ? | |
| SC-40 | Supply chain | CI actions are pinned by commit; workflow permissions and secrets are the minimum per job | ? | |
| SC-41 | Supply chain | Images use pinned bases, contain no dev dependencies or secrets, and are scanned | ? | |
| SC-42 | SDLC | Every change to main passes the gates (lint, types, tests, SAST, secret scan) and deploys only through CI | ? | |
| SC-43 | SDLC | Every security finding is tracked to a fix with a regression test, or to a recorded acceptance | ? | |
| SC-44 | Deployment | Security settings are actually on in each deployment (CSP enforcing, auth on, caps set), checked from outside | ? | |
| SC-45 | Defaults | Defaults are safe: a new mission is capped, agents get minimal tools, copilot actions are gated | ? | |
| SC-46 | Errors | Error responses do not reveal stack traces, paths or internal identifiers to a less-trusted caller | ? | |
| SC-47 | Response | There is a way to stop a misbehaving agent or mission at once (pause, suspend, cap) and it is documented | ? | |
