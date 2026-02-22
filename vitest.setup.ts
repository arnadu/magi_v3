/**
 * Global test setup — runs in every vitest worker before test files are loaded.
 *
 * - Loads .env from the project root so integration tests can read ANTHROPIC_API_KEY etc.
 * - Polyfills the `File` global for Node 18 compatibility with undici v7.
 *   (Remove polyfill once we upgrade to Node >= 20.)
 */
import { config } from "dotenv";

config({ quiet: true });
if (typeof globalThis.File === "undefined") {
	// biome-ignore lint/suspicious/noExplicitAny: setting an unknown global requires any
	(globalThis as any).File = class extends Blob {
		readonly name: string;
		readonly lastModified: number;
		constructor(bits: BlobPart[], name: string, options?: FilePropertyBag) {
			super(bits, options);
			this.name = name;
			this.lastModified = options?.lastModified ?? Date.now();
		}
	};
}
