/**
 * Polyfill for Node.js < 20.
 * Loaded via `node --import ./dist/node-polyfill.js` before the main entry
 * point so that `File` is available globally before undici (Stagehand dep)
 * tries to reference it at module-load time.
 */
// Synchronous write so this appears in Fly logs even if daemon.js never loads.
process.stdout.write(`[polyfill] Node ${process.version} started, uid=${process.getuid?.() ?? "?"}\n`);

if (typeof File === "undefined") {
	const { File: NodeFile } = await import("node:buffer");
	(globalThis as Record<string, unknown>).File = NodeFile;
}

process.stdout.write("[polyfill] Polyfill done, loading daemon…\n");

export {};
