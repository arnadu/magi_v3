/**
 * Validation of LLM-supplied tool arguments against the tool's own TypeBox
 * schema, before `execute` sees them (LP2).
 *
 * Every tool declares `parameters`, and that schema is what the model is
 * shown — but until this existed the arguments went straight from the
 * provider's JSON into `execute`, where each tool cast them. A missing or
 * mistyped field then surfaced as a `TypeError` deep inside the tool (an
 * unhandled 500 on the Tool API, a crashed turn in the loop) or, worse, as a
 * silently wrong action: the common root of the audit's EA1, MB1, DOC4, OB6
 * and MC7/MC8. A schema failure is now a normal tool error the model can read
 * and correct on its next call.
 *
 * The obvious coercions ("5" for a number, "true" for a boolean) are applied
 * before checking, so sloppy-but-unambiguous calls still run; the tool
 * receives the converted copy, never the model's original object.
 */

import {
	validateToolArguments as piValidate,
	type ToolCall,
} from "@mariozechner/pi-ai";
import { Value } from "@sinclair/typebox/value";
import type { MagiTool } from "./tools.js";

/** A rejection message must fit comfortably in the model's context; the received-arguments dump pi-ai appends can be megabytes (a WriteFile body). */
export const MAX_REJECTION_CHARS = 4_000;

export type ToolArgsCheck =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; message: string };

export function checkToolArguments(
	tool: Pick<MagiTool, "name" | "parameters">,
	call: { id: string; name: string; arguments: unknown },
): ToolArgsCheck {
	// pi-ai's own convert pass is a no-op for schemas built with this
	// package's TypeBox (it only coerces plain JSON-schema objects), so the
	// unambiguous conversions ("5" → 5, "true" → true) are applied here first,
	// on a copy; what the tool receives is this converted copy.
	const raw = (call.arguments ?? {}) as Record<string, unknown>;
	const converted = Value.Convert(tool.parameters, structuredClone(raw));
	const toolCall: ToolCall = {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: converted as Record<string, unknown>,
	};
	try {
		const args = piValidate(
			{ name: tool.name, description: "", parameters: tool.parameters },
			toolCall,
		) as Record<string, unknown>;
		return { ok: true, args };
	} catch (e) {
		return { ok: false, message: boundedRejection(e) };
	}
}

function boundedRejection(e: unknown): string {
	const full = e instanceof Error ? e.message : String(e);
	if (full.length <= MAX_REJECTION_CHARS) return full;
	// Keep the per-field errors (first lines) and drop the tail of the echoed
	// arguments; the model still has its own call in context.
	return `${full.slice(0, MAX_REJECTION_CHARS)}\n… [rejection message truncated at ${MAX_REJECTION_CHARS} chars]`;
}
