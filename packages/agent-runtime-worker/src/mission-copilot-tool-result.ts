/** Tool-result shapes shared by the mission copilot's tool modules. */

import type { ToolResult } from "./tools.js";
import { truncate } from "./tools.js";

export function ok(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }] };
}
export function err(text: string): ToolResult {
	return { content: [{ type: "text", text: truncate(text) }], isError: true };
}
export function okJson(data: unknown): ToolResult {
	return ok(JSON.stringify(data, null, 2));
}
