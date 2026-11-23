import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
declare const root: string;
declare function resolveInside(root: string, p: string): string;
declare function readInside(root: string, p: string): Buffer;
declare function routeParam(req: unknown, name: string): string;
type Req = { query: Record<string, string>; params: Record<string, string>; body: { path: string } };

function express(req: Req) {
	// ruleid: magi-path-from-request
	readFileSync(join(root, req.query.path));
	// ruleid: magi-path-from-request
	writeFileSync(req.body.path, "x");
	const name = routeParam(req, "name");
	// ruleid: magi-path-from-request
	createReadStream(`${root}/${name}`);
	// ok: magi-path-from-request
	readFileSync(resolveInside(root, req.query.path));
	// ok: magi-path-from-request
	readInside(root, req.params.file);
	// ok: magi-path-from-request
	readFileSync(join(root, "fixed.json"));
}

function monitor(url: URL) {
	const p = url.searchParams.get("path") ?? "";
	// ruleid: magi-path-from-request
	readFileSync(join(root, p));
	const safe = resolveInside(root, p);
	// ok: magi-path-from-request
	readFileSync(safe);
}
