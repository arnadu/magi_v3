// Planted samples for `bash scripts/audit/tripwires.sh --selftest`. One line per check. This file
// is never compiled or imported; it exists so a tripwire that stops matching (a typo in a pattern,
// a grep that silently finds nothing) fails CI instead of passing vacuously.
/* T1 */ const t1 = process.env.SOMETHING;
/* T2 */ el.innerHTML = untrusted;
/* T3 */ const t3 = `<a href="${url}">`;
/* T4 */ const t4 = join(root, req.query.path);
/* T5 */ execFileSync("ls", ["-la"]);
/* T6 */ execFile("git", ["-C", dir, "status"]);
/* T7 */ router.get("/x", async (req, res) => {});
/* T8 */ try { x(); } catch (e) {}
/* T8b */ void p.catch(() => {});
/* T9 */ const t9 = value as any;
/* T10 */ maxCostUsd: z.number().optional(),
// T11: Sprint 99 bookkeeping comment that should be an ADR link
/* T12 */ await db.collection("mailbox").insertOne(doc);
/* T13 */ db.collection("missions");
