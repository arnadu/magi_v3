# Traceability — working practice

The root `CLAUDE.md` keeps the one-line triggers; this is the full text. The design is
[ADR-0036](../adr/0036-product-and-architecture-baselines.md).

## The idea

The product baseline ([docs/product/](../product/README.md)) says what MAGI is meant to do:
actors, entities and their states, operations, journeys. The code says what it does. The two
are joined by ids, put in by hand at a few places and checked by machine; everything else
(what each entry point reaches, which code writes a status) is computed by scans.

## Every entry point declares what it serves

An entry point is anything an actor or the platform starts work through: a route, a tool, a
copilot action, a name in the background jobs' Tool API, a timer or change stream. Each one
declares the **operation** it serves (`mission.launch`, `agent.dispatch`, …), or, when it serves
no product operation, an **entry class** (`infrastructure`, `developer`, `sub-agent`, `feed`,
`housekeeping`, `retired`). Both lists are in [operations.md](../product/operations.md).

| Entry point | Where the tag goes | Checked by |
|---|---|---|
| Tool (agents, both copilots, sub-agents) | `operation:` on the `MagiTool` object | `tsc` (required field) |
| Monitor route (mission machine) | `operation:` on the `RouteEntry` | `tsc` (required field) |
| Control-plane route through `asyncRoutes` | second argument: `routes.get("/x", "mission.status", h)` | `tsc` |
| Control-plane route on a bare router | first handler: `router.get("/x", operation("mission.status"), h)` | the entry-point test |
| Control-copilot action | `ACTION_OPERATIONS` in `copilot-actions.ts` | `tsc` (exhaustive record) |
| Tool API name | `operation:` on its entry in `tool-api-server.ts` | `tsc` |
| Cron, interval, change stream, cooldown | wrap the callback: `schedule("* * * * *", entryTrigger("schedule.deliver", tick))` | the entry-point test |

The tag is a type (`EntryTag` from `@magi/agent-config`): a misspelt id fails `tsc`.
`npm run trace:entry-points` lists every entry point with its tag;
`packages/agent-config/tests/entry-points.unit.test.ts` fails on one without a tag, on an id
not in the catalog, and checks the scan itself against planted examples.

## Choosing the tag

- **Pick by intent, not by code path.** Two entry points that ask for the same thing with the
  same rules serve the same operation, even when they reach different code today. Tag them
  honestly; a difference in what they reach is for the scans to report, not for the tag to hide.
- **No operation fits?** Do not stretch the nearest one. Propose a new operation, or an entry
  class, as a change to the catalog (`packages/agent-config/src/baseline/`): the product owner
  approves it. The granularity rule heads [operations.md](../product/operations.md).
- **A timer or stream that only feeds an open route's response** is `feed`; the route declares
  the operation.

## Changing intent

- A change to what MAGI should do is a change to the catalog first, approved by the product
  owner, then the code. Run `npm run docs:baseline` to regenerate the documents.
- A test that walks a journey or enforces an invariant names its id (`J-04`, `mission.capped`)
  in its title.
