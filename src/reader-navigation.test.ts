import { describe, expect, it } from "vitest";
import { readerQuery, startsReaderQuery } from "./reader-navigation";

describe("reader query contract", () => {
	it("routes digits incrementally but explicit text preserves numbers and spaces", () => {
		for (const value of ["1", "11", "115", "65"]) expect(readerQuery(value, "auto").line).toBe(Number(value));
		expect(readerQuery("115", "text")).toEqual({ text: "115", line: null, kind: "text" });
		expect(readerQuery(" 115 ", "text").text).toBe(" 115 ");
		expect(readerQuery("12x", "auto").kind).toBe("text");
		expect(readerQuery("9007199254740993", "line").line).toBeNull();
	});
	it("does not capture shortcuts or input method composition", () => {
		const event = {
			key: "x",
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			isComposing: false,
			keyCode: 88,
		};
		expect(startsReaderQuery(event)).toBe(true);
		for (const patch of [
			{ metaKey: true },
			{ ctrlKey: true },
			{ altKey: true },
			{ isComposing: true },
			{ keyCode: 229 },
			{ key: "ArrowDown" },
		])
			expect(startsReaderQuery({ ...event, ...patch })).toBe(false);
	});
});
