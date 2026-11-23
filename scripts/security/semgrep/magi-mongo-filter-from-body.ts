declare const col: { findOne(f: unknown): unknown; updateOne(f: unknown, u: unknown): unknown; deleteMany(f: unknown): unknown };
declare const schema: { parse(x: unknown): { name: string } };
type Req = { body: { missionId: unknown; name: unknown } };

function handler(req: Req) {
	// ruleid: magi-mongo-filter-from-body
	col.findOne({ missionId: req.body.missionId });
	const { name } = req.body;
	// ruleid: magi-mongo-filter-from-body
	col.deleteMany({ name });
	// ok: magi-mongo-filter-from-body
	col.findOne({ missionId: String(req.body.missionId) });
	const parsed = schema.parse(req.body);
	// ok: magi-mongo-filter-from-body
	col.findOne({ name: parsed.name });
	// ok: magi-mongo-filter-from-body
	col.updateOne({ missionId: "m1" }, { $set: { name: req.body.name } });
	const raw: unknown = (req.body as { ids?: unknown }).ids;
	const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
	// ok: magi-mongo-filter-from-body
	col.deleteMany({ id: { $in: ids } });
}
