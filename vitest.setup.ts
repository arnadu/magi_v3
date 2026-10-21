/**
 * Global test setup — runs in every vitest worker before test files are loaded.
 * Loads .env from the project root so integration tests can read
 * ANTHROPIC_API_KEY etc.
 */
import { config } from "dotenv";

config({ quiet: true });
