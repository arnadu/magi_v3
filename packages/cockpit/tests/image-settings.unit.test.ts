import { describe, expect, it } from "vitest";
import {
	type ImageMenuItem,
	imageFieldsForSave,
	imageSettingsOf,
	isKindEnabled,
	kindLabel,
	kindsNote,
	menuKinds,
	menuLine,
	toggleKind,
} from "../src/image-settings";

const item = (id: string, kind: string): ImageMenuItem => ({
	id,
	kind,
	tiers: ["draft"],
	output: kind === "vector" ? "svg" : "raster",
	ceilingUsdPerImage: 0.16,
	strengths: "",
});
const MENU = [
	item("a/vec", "vector"),
	item("a/vec-pro", "vector"),
	item("b/art", "raster-art"),
	item("c/ins", "raster-instruct"),
];
const ALL = menuKinds(MENU);

describe("image settings", () => {
	it("lists the menu's kinds once each, in menu order, and formats a model line with its ceiling", () => {
		expect(ALL).toEqual(["vector", "raster-art", "raster-instruct"]);
		expect(kindLabel("vector")).toBe("Logos and icons (SVG)");
		expect(kindLabel("new-kind")).toBe("new-kind");
		expect(menuLine(MENU[0])).toBe(
			"a/vec — draft, SVG, at most $0.16 per image",
		);
	});

	it("reads a stored mission: no restriction means every kind", () => {
		expect(imageSettingsOf({})).toEqual({
			imageAgentModel: "",
			imageKinds: null,
		});
		expect(
			imageSettingsOf({ imageAgentModel: "x/y", imageModels: ["vector"] }),
		).toEqual({ imageAgentModel: "x/y", imageKinds: ["vector"] });
		expect(isKindEnabled(null, "vector")).toBe(true);
	});

	it("unticking from no restriction keeps the other kinds; re-ticking restores menu order", () => {
		const one = toggleKind(null, "raster-art", ALL);
		expect(one).toEqual(["vector", "raster-instruct"]);
		expect(toggleKind(one, "raster-art", ALL)).toEqual(ALL);
	});

	it("saves a real restriction only; all or none ticked saves as no restriction, with a note for none", () => {
		const d = { imageAgentModel: " ", imageKinds: ["raster-art"] };
		expect(imageFieldsForSave(d, ALL)).toEqual({ imageModels: ["raster-art"] });
		expect(imageFieldsForSave({ ...d, imageKinds: [...ALL] }, ALL)).toEqual({});
		expect(imageFieldsForSave({ ...d, imageKinds: [] }, ALL)).toEqual({});
		expect(kindsNote([], ALL)).toMatch(/disable the CreateImage tool/);
		expect(kindsNote(null, ALL)).toBeUndefined();
		expect(
			imageFieldsForSave({ imageAgentModel: " x/y ", imageKinds: null }, ALL),
		).toEqual({ imageAgentModel: "x/y" });
	});

	it("keeps a stored restriction when the menu has not loaded", () => {
		expect(
			imageFieldsForSave({ imageAgentModel: "", imageKinds: ["vector"] }, []),
		).toEqual({ imageModels: ["vector"] });
	});
});
