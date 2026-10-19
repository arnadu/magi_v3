/**
 * The last-resort handler for a process entry point's `main()`: say which
 * process died and why (message, then stack), and exit non-zero so a
 * supervisor (Fly, pm2) sees the failure.
 */
export function exitOnFatal(process_: string): (e: unknown) => never {
	return (e: unknown) => {
		const err = e instanceof Error ? e : new Error(String(e));
		console.error(`[${process_}] fatal: ${err.message}`);
		if (err.stack) console.error(err.stack);
		process.exit(1);
	};
}
