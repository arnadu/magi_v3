/**
 * #my-objectives mental-map bridge — unit tests (Sprint 26a, deliverable B1).
 */

import { describe, expect, it } from "vitest";
import {
	createMentalMapTool,
	upsertManagedSection,
} from "../src/mental-map.js";
import {
	MY_OBJECTIVES_ID,
	renderMyObjectives,
} from "../src/objectives/agent-view.js";
import { foldStore } from "../src/objectives/store.js";
import type {
	GoalsFile,
	KpiEvent,
	TaskEvent,
} from "../src/objectives/types.js";

const T = (n: number) => `2026-06-25T0${n}:00:00.000Z`;

const goals: GoalsFile = {
	objectives: [
		{
			id: "OBJ-1",
			parent: null,
			title: "Compliance",
			owner: "records-officer",
			status: "active",
			budgetUsd: 4,
			kpis: [
				{
					id: "K1",
					label: "records reconciled",
					owner: "records-officer",
					kind: "quantitative",
					source: "agent-reported",
				},
				{
					id: "K2",
					label: "coverage",
					owner: "lead",
					kind: "qualitative",
					source: "copilot-assessment",
				},
			],
		},
	],
};
const taskEvents: TaskEvent[] = [
	{
		id: "T1",
		at: T(1),
		by: "lead",
		title: "Inventory activities",
		objective: "OBJ-1",
		assignee: "records-officer",
		status: "in-progress",
	},
	{
		id: "T2",
		at: T(1),
		by: "lead",
		title: "Done thing",
		objective: "OBJ-1",
		assignee: "records-officer",
		status: "completed",
	},
	{
		id: "T3",
		at: T(1),
		by: "lead",
		title: "Someone else's",
		objective: "OBJ-1",
		assignee: "assessor",
		status: "open",
	},
];

describe("renderMyObjectives", () => {
	it("shows owned objective, owned KPIs (with freshness), and open assigned tasks", () => {
		const tree = foldStore({
			goals,
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		const html = renderMyObjectives(tree, "records-officer");
		expect(html).not.toBeNull();
		const s = html as string;
		// owns OBJ-1
		expect(s).toContain("OBJ-1");
		expect(s).toContain("Compliance");
		// owns K1 (records-officer) — never reported → stale, record-kpi hint
		expect(s).toContain("K1");
		expect(s).toContain("record-kpi --kpi K1");
		// does NOT own K2 (lead owns it)
		expect(s).not.toContain("K2");
		// open assigned task shown; completed + other-agent tasks not
		expect(s).toContain("T1");
		expect(s).not.toContain("T2");
		expect(s).not.toContain("Someone else's");
	});

	it("reports no open tasks when the agent has none (lead owns K2, no tasks)", () => {
		const tree = foldStore({
			goals,
			taskEvents,
			kpiEvents: [],
			costEvents: [],
		});
		const html = renderMyObjectives(tree, "lead") as string;
		expect(html).toContain("K2"); // still shows the KPI it owns
		expect(html).toContain("No open tasks");
	});

	it("returns null for an empty store (mission not using objectives)", () => {
		const tree = foldStore({
			goals: { objectives: [] },
			taskEvents: [],
			kpiEvents: [],
			costEvents: [],
		});
		expect(renderMyObjectives(tree, "anyone")).toBeNull();
	});

	it("drops the freshness flag once the KPI is reported", () => {
		const kpiEvents: KpiEvent[] = [
			{ kpi: "K1", value: 40, by: "records-officer", at: T(2) },
		];
		const tree = foldStore({ goals, taskEvents, kpiEvents, costEvents: [] });
		const s = renderMyObjectives(tree, "records-officer") as string;
		expect(s).toContain("K1");
		expect(s).not.toContain("record-kpi --kpi K1");
	});
});

describe("upsertManagedSection", () => {
	it("creates the section at the top when absent", () => {
		const out = upsertManagedSection(
			'<section id="working-notes"><p>hi</p></section>',
			MY_OBJECTIVES_ID,
			"<p>owned</p>",
		);
		expect(out).toContain('id="my-objectives"');
		expect(out.indexOf("my-objectives")).toBeLessThan(
			out.indexOf("working-notes"),
		);
	});

	it("replaces the section content when present (no duplication)", () => {
		const first = upsertManagedSection(
			"<p></p>",
			MY_OBJECTIVES_ID,
			"<p>v1</p>",
		);
		const second = upsertManagedSection(first, MY_OBJECTIVES_ID, "<p>v2</p>");
		expect(second).toContain("v2");
		expect(second).not.toContain("v1");
		expect(second.match(/id="my-objectives"/g)?.length).toBe(1);
	});

	it("strips scripts from injected content", () => {
		const out = upsertManagedSection(
			"<p></p>",
			MY_OBJECTIVES_ID,
			"<p>ok</p><script>alert(1)</script>",
		);
		expect(out).not.toContain("<script>");
		expect(out).toContain("ok");
	});
});

describe("createMentalMapTool protected ids", () => {
	it("rejects edits to a protected (managed) section", async () => {
		let html =
			'<section id="my-objectives"><p>managed</p></section><section id="working-notes"></section>';
		const tool = createMentalMapTool(
			() => html,
			(h) => {
				html = h;
			},
			new Set([MY_OBJECTIVES_ID]),
		);
		const res = await tool.execute("1", {
			operation: "replace",
			elementId: "my-objectives",
			content: "<p>hacked</p>",
		});
		expect(res.isError).toBe(true);
		expect(html).toContain("managed"); // unchanged
	});

	it("still allows edits to normal sections", async () => {
		let html = '<section id="working-notes"></section>';
		const tool = createMentalMapTool(
			() => html,
			(h) => {
				html = h;
			},
			new Set([MY_OBJECTIVES_ID]),
		);
		const res = await tool.execute("1", {
			operation: "replace",
			elementId: "working-notes",
			content: "<p>note</p>",
		});
		expect(res.isError).toBeUndefined();
		expect(html).toContain("note");
	});
});
