/**
 * Module augmentation for express-serve-static-core.
 *
 * TypeScript cannot resolve `import * as http from "http"` inside node_modules
 * .d.ts files because ambient module declarations (from @types/node) are not
 * used as a fallback during file-system module resolution for lib files.
 * The result is that Request, Response, and NextFunction lose the properties
 * they inherit from http.IncomingMessage / http.ServerResponse.
 *
 * This file re-adds those properties using imports from "node:http" which
 * resolves correctly in our own compilation context.
 */
import type {
	IncomingHttpHeaders,
	IncomingMessage,
	ServerResponse,
} from "node:http";

declare module "express-serve-static-core" {
	// Re-add IncomingMessage properties lost due to broken http resolution.
	interface Request {
		headers: IncomingHttpHeaders;
		method?: string | undefined;
		url?: string | undefined;
		socket: IncomingMessage["socket"];
		// biome-ignore lint/suspicious/noExplicitAny: must match IncomingMessage.on overload signature
		on(event: string, listener: (...args: any[]) => void): this;
		// Auth context injected by requireAuth middleware.
		userId: string;
		isAdmin: boolean;
	}

	// Re-add ServerResponse properties lost due to broken http resolution.
	interface Response {
		statusCode: number;
		headersSent: boolean;
		setHeader(name: string, value: number | string | readonly string[]): this;
		removeHeader(name: string): this;
		flushHeaders(): void;
		write(
			chunk: unknown,
			encoding?: BufferEncoding | ((error: Error | null | undefined) => void),
			callback?: (error: Error | null | undefined) => void,
		): boolean;
		end(
			chunk?: unknown,
			encoding?: BufferEncoding | (() => void),
			callback?: () => void,
		): this;
		socket: ServerResponse["socket"];
	}

	// Re-add call signature to NextFunction.
	type NextFunction = (err?: unknown) => void;
}
