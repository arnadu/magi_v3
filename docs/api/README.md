# The HTTP surfaces, as OpenAPI files

Generated from the code, never edited by hand: `packages/control-plane/tests/api-surface.unit.test.ts`
builds each surface as the code assembles it and compares it with the file here. After adding,
removing or moving a route, run `npm run docs:api` and commit the result.

| File | Surface | Reached by | Credential |
|---|---|---|---|
| `control-plane.openapi.json` | The cockpit's API, the mission-copilot proxy, the proxy to mission machines | The internet | Operator (Firebase token, session cookie or admin key); a mission's monitor token for `/api/mission-copilot` |
| `apps-host.openapi.json` | Interactive apps (ADR-0037) | The internet | A signed ticket, then the app's session cookie |
| `monitor.openapi.json` | A mission machine's port 4000 | Fly's private network | The per-mission monitor token; the apps token for `/a/…` |
| `tool-api.openapi.json` | A mission machine's port 4001 | Loopback, background jobs | The job's `MAGI_TOOL_TOKEN` |

Extensions on each operation: `x-magi-operation` (the catalog operation it serves),
`x-magi-auth` (which credential), `x-magi-any-method`, `x-magi-forwards` (a pass-through to
another surface) and `x-magi-pattern` (the regular expression a monitor route really matches).

The test also enforces that every route names an operation the catalog defines, and that a
route is public only when it is listed with its reason. Request bodies are declared as plain
objects until each route's Zod schema is attached. These files are the scanners' target list
(Nuclei, `docs/plans/security-assurance-plan.md`) and the attack matrix's HTTP cells.
