import { describe, expect, it } from "vitest";
import { parseWorkspace } from "./boa";

describe("workspace CLI requests", () => {
	it("supports an individual-file space without a parent folder root", () => {
		expect(parseWorkspace(["spaces", "save", "logo", "--name", "Logo", "--file", "/tmp/logo.png"])).toEqual({
			command: "workspace",
			request: { action: "save-space", id: "logo", name: "Logo", roots: [], files: ["/tmp/logo.png"] },
		});
	});
	it("represents multi-root spaces and ordered file selections without editing config", () => {
		expect(
			parseWorkspace(["spaces", "save", "tools", "--name", "Tools", "--root", "/tmp/a", "--root", "/tmp/b"]),
		).toEqual({
			command: "workspace",
			request: { action: "save-space", id: "tools", name: "Tools", roots: ["/tmp/a", "/tmp/b"] },
		});
		expect(
			parseWorkspace([
				"files",
				"configure",
				"/tmp/a",
				"--include",
				"skills",
				"--pin",
				"README.md",
				"--pin",
				"skills",
				"--sort",
				"modified",
			]),
		).toMatchObject({
			request: {
				preferences: {
					filtered: true,
					included: ["skills"],
					pins: ["README.md", "skills"],
					sort: "modified",
				},
			},
		});
		expect(() => parseWorkspace(["spaces", "save", "test", "--name", "Tools"])).toThrow();
		expect(() => parseWorkspace(["files", "configure", "/tmp", "--sort", "bad"])).toThrow();
		expect(() => parseWorkspace(["files", "configure", "/tmp", "--pin", "../escape"])).toThrow();
		expect(() => parseWorkspace(["spaces", "list", "--pin", "README.md"])).toThrow();
	});
});
