/**
 * Boot banner, loaded via `node --import ./dist/node-polyfill.js` before the
 * daemon's entry point: these lines reach the Fly logs even when daemon.js
 * fails while its modules load. (It once also polyfilled `File` for Node
 * < 20; the engines field now requires Node 22.15+, where `File` is global.)
 */
// Synchronous write so this appears in Fly logs even if daemon.js never loads.
process.stdout.write(
	`[polyfill] Node ${process.version} started, uid=${process.getuid?.() ?? "?"}\n`,
);
process.stdout.write("[polyfill] Loading daemon…\n");

export {};
