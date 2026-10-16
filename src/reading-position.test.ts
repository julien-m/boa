import { expect, it } from "vitest";
import { relocateLine } from "./reading-position";

it("keeps table eight visible when earlier tables are inserted", () => {
	const before = Array.from({ length: 12 }, (_, i) => `CREATE TABLE table_${i + 1};\n  id INTEGER;\n);`).join(
		"\n",
	);
	const after = `${before.slice(0, before.indexOf("CREATE TABLE table_8"))}CREATE TABLE inserted_a;\nCREATE TABLE inserted_b;\n${before.slice(before.indexOf("CREATE TABLE table_8"))}`;
	expect(relocateLine(before, after, 22)).toBe(24);
	// Repeated column names are resolved with neighboring table text.
	expect(relocateLine(before, after, 23)).toBe(25);
});

it("uses nearby surviving text after deletion, and clamps when no text survives", () => {
	expect(relocateLine("one\ntwo\nthree\nfour", "intro\none\nthree\nfour", 2)).toBe(3);
	expect(relocateLine("one\ntwo\nthree", "new", 3)).toBe(1);
	expect(relocateLine("", "", 1)).toBe(1);
});
