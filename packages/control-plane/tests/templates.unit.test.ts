/**
 * Templates — immutable, disk-only loader + read-only router (ADR-0021).
 *
 * No MongoDB. Templates are loaded from a temp directory shaped like
 * config/teams/, mirroring the on-disk layout the real loadTemplates()
 * reads at control-plane startup.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTemplatesRouter,
	getTemplate,
	listTemplates,
	loadTemplates,
} from "../src/templates.js";

function validYaml(id: string, name: string): string {
	return `
mission:
  id: ${id}
  name: "${name}"
agents:
  - id: analyst
    supervisor: user
    systemPrompt: |
      You are an analyst.
    initialMentalMap: |
      <section id="status"><p>Ready.</p></section>
`;
}

describe("templates.ts (ADR-0021 disk-only templates)", () => {
	let repoRoot: string;
	let teamsDir: string;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "magi-templates-test-"));
		teamsDir = join(repoRoot, "config", "teams");
		mkdirSync(teamsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	describe("loadTemplates / getTemplate / listTemplates", () => {
		it("loads every non-test, non-copilot .yaml file into the in-memory map", () => {
			writeFileSync(
				join(teamsDir, "alpha.yaml"),
				validYaml("alpha", "Alpha Team"),
			);
			writeFileSync(
				join(teamsDir, "beta.yaml"),
				validYaml("beta", "Beta Team"),
			);
			writeFileSync(join(teamsDir, "copilot.yaml"), validYaml("copilot", "x"));

			loadTemplates(repoRoot);

			const listed = listTemplates();
			expect(listed.map((t) => t.id).sort()).toEqual(["alpha", "beta"]);
		});

		it("getTemplate returns the full config + teamFiles for a known id", () => {
			writeFileSync(
				join(teamsDir, "alpha.yaml"),
				validYaml("alpha-template-id", "Alpha Team"),
			);
			const alphaDir = join(teamsDir, "alpha");
			mkdirSync(join(alphaDir, "skills", "foo"), { recursive: true });
			writeFileSync(join(alphaDir, "skills", "foo", "SKILL.md"), "# Foo skill");

			loadTemplates(repoRoot);

			const template = getTemplate("alpha");
			expect(template).not.toBeNull();
			expect(template?.name).toBe("Alpha Team");
			expect(template?.config.mission.name).toBe("Alpha Team");
			expect(template?.config.agents).toHaveLength(1);
			expect(template?.teamFiles).toEqual([
				{ path: "skills/foo/SKILL.md", content: "# Foo skill" },
			]);
		});

		it("getTemplate returns null for an unknown id", () => {
			loadTemplates(repoRoot);
			expect(getTemplate("does-not-exist")).toBeNull();
		});

		it("skips an invalid template file and still loads the others", () => {
			writeFileSync(join(teamsDir, "broken.yaml"), "not: [valid, yaml,");
			writeFileSync(
				join(teamsDir, "good.yaml"),
				validYaml("good", "Good Team"),
			);

			loadTemplates(repoRoot);

			expect(listTemplates().map((t) => t.id)).toEqual(["good"]);
			expect(getTemplate("broken")).toBeNull();
		});

		it("a missing config/teams directory yields an empty template set, not a throw", () => {
			rmSync(teamsDir, { recursive: true, force: true });
			expect(() => loadTemplates(repoRoot)).not.toThrow();
			expect(listTemplates()).toEqual([]);
		});

		it("re-running loadTemplates replaces the previous set entirely", () => {
			writeFileSync(join(teamsDir, "alpha.yaml"), validYaml("alpha", "Alpha"));
			loadTemplates(repoRoot);
			expect(listTemplates().map((t) => t.id)).toEqual(["alpha"]);

			rmSync(join(teamsDir, "alpha.yaml"));
			writeFileSync(join(teamsDir, "beta.yaml"), validYaml("beta", "Beta"));
			loadTemplates(repoRoot);
			expect(listTemplates().map((t) => t.id)).toEqual(["beta"]);
		});
	});

	describe("createTemplatesRouter (read-only)", () => {
		let server: Server;
		let baseUrl: string;

		function startServer(app: express.Express): Promise<void> {
			return new Promise((resolve) => {
				server = app.listen(0, "127.0.0.1", () => {
					const addr = server.address();
					const port = typeof addr === "object" && addr ? addr.port : 0;
					baseUrl = `http://127.0.0.1:${port}`;
					resolve();
				});
			});
		}

		afterEach(() => {
			server?.close();
		});

		it("GET / lists templates sorted by id", async () => {
			writeFileSync(join(teamsDir, "zeta.yaml"), validYaml("zeta", "Zeta"));
			writeFileSync(join(teamsDir, "alpha.yaml"), validYaml("alpha", "Alpha"));
			loadTemplates(repoRoot);

			const app = express();
			app.use("/api/templates", createTemplatesRouter());
			await startServer(app);

			const res = await fetch(`${baseUrl}/api/templates`);
			const body = (await res.json()) as Array<{ id: string }>;

			expect(res.status).toBe(200);
			expect(body.map((t) => t.id)).toEqual(["alpha", "zeta"]);
		});

		it("GET /:id returns the full template", async () => {
			writeFileSync(join(teamsDir, "alpha.yaml"), validYaml("alpha", "Alpha"));
			loadTemplates(repoRoot);

			const app = express();
			app.use("/api/templates", createTemplatesRouter());
			await startServer(app);

			const res = await fetch(`${baseUrl}/api/templates/alpha`);
			const body = (await res.json()) as {
				id: string;
				config: { mission: { name: string } };
				teamFiles: unknown[];
			};

			expect(res.status).toBe(200);
			expect(body.id).toBe("alpha");
			expect(body.config.mission.name).toBe("Alpha");
			expect(body.teamFiles).toEqual([]);
		});

		it("GET /:id 404s for an unknown template", async () => {
			loadTemplates(repoRoot);
			const app = express();
			app.use("/api/templates", createTemplatesRouter());
			await startServer(app);

			const res = await fetch(`${baseUrl}/api/templates/nope`);
			expect(res.status).toBe(404);
		});

		it("has no POST / or PUT /:id route — templates are immutable", async () => {
			loadTemplates(repoRoot);
			const app = express();
			app.use(express.json());
			app.use("/api/templates", createTemplatesRouter());
			await startServer(app);

			const postRes = await fetch(`${baseUrl}/api/templates`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "x", name: "x" }),
			});
			expect(postRes.status).toBe(404);

			const putRes = await fetch(`${baseUrl}/api/templates/alpha`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "x" }),
			});
			expect(putRes.status).toBe(404);
		});
	});
});
