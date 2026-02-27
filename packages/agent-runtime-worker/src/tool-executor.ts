/**
 * tool-executor.ts — clean child entry point for isolated tool execution.
 *
 * Launched by the orchestrator via:
 *   sudo -u magi-wN node dist/tool-executor.js
 *
 * Environment: only PATH and HOME are set — NO ANTHROPIC_API_KEY or other
 * orchestrator secrets. This is the security boundary.
 *
 * Protocol:
 *   stdin  → ToolRequest JSON (from orchestrator)
 *   stdout → ToolResponse JSON (to orchestrator)
 *   stderr → any diagnostic output
 */

// Redirect all console output to stderr so stdout stays clean for the JSON result.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

import {
	execBash,
	execEditFile,
	execWriteFile,
	type ToolRequest,
	type ToolResponse,
} from "./tools.js";

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
	let req: ToolRequest;
	try {
		const raw = await readStdin();
		req = JSON.parse(raw) as ToolRequest;
	} catch (e) {
		const resp: ToolResponse = {
			ok: false,
			text: `tool-executor: failed to parse stdin: ${(e as Error).message}`,
		};
		process.stdout.write(JSON.stringify(resp));
		process.exit(1);
	}

	const { tool, args, workdir, permittedPaths, agentId, timeoutMs } = req;

	let result: ToolResponse;
	switch (tool) {
		case "Bash": {
			const r = execBash(
				args.command as string,
				workdir,
				(args.timeout as number) ?? timeoutMs ?? 30_000,
				permittedPaths,
				agentId,
			);
			result = { ok: !r.isError, text: r.content[0].text };
			break;
		}
		case "WriteFile": {
			const r = execWriteFile(
				args.path as string,
				args.content as string,
				workdir,
				permittedPaths,
				agentId,
			);
			result = { ok: !r.isError, text: r.content[0].text };
			break;
		}
		case "EditFile": {
			const r = execEditFile(
				args.path as string,
				args.old_string as string,
				args.new_string as string,
				args.replace_all === true,
				workdir,
				permittedPaths,
				agentId,
			);
			result = { ok: !r.isError, text: r.content[0].text };
			break;
		}
		default: {
			result = {
				ok: false,
				text: `tool-executor: unknown tool "${tool}"`,
			};
		}
	}

	process.stdout.write(JSON.stringify(result));
}

main().catch((e) => {
	const resp: ToolResponse = {
		ok: false,
		text: `tool-executor: unexpected error: ${(e as Error).message}`,
	};
	process.stdout.write(JSON.stringify(resp));
	process.exit(1);
});
