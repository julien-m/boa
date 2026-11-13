// @vitest-environment happy-dom

import { languages } from "monaco-editor/editor/editor.api.js";
import { describe, expect, it } from "vitest";
import "monaco-editor/basic-languages/monaco.contribution.js";
import "./syntax-highlighting";
import { createSourceLanguageResolver } from "./source-language";

const resolveLanguage = createSourceLanguageResolver(languages.getLanguages());

describe("source language selection", () => {
	it("recognizes Delphi units, projects, packages and textual forms", () => {
		for (const path of ["unit.pas", "app.dpr", "package.dpk", "form.dfm", "form.fmx", "UNIT.PAS"]) {
			expect(resolveLanguage(path)).toBe("pascal");
		}
	});
	it("uses the installed language registry for source files and explicit basenames", () => {
		for (const [path, language] of [
			["app.js", "javascript"],
			["app.mjs", "javascript"],
			["app.cjs", "javascript"],
			["app.jsx", "javascript"],
			["app.ts", "typescript"],
			["app.tsx", "typescript"],
			["app.mts", "typescript"],
			["lib.rs", "rust"],
			["lib.ex", "elixir"],
			["mix.exs", "elixir"],
			["App.swift", "swift"],
			["main.go", "go"],
			["app.py", "python"],
			["config.toml", "toml"],
			["config.jsonc", "json"],
			["form.svg", "xml"],
			["Dockerfile", "dockerfile"],
			["folder.dots/DOCKERFILE", "dockerfile"],
			["src/main.cpp", "cpp"],
		])
			expect(resolveLanguage(path)).toBe(language);
	});
	it("matches the longest suffix and gives explicit filenames precedence", () => {
		const resolve = createSourceLanguageResolver([
			{ id: "short", extensions: [".ts"] },
			{ id: "declaration", extensions: [".d.ts"] },
			{ id: "special", filenames: ["special.d.ts"] },
		]);
		expect(resolve("src/types.D.TS")).toBe("declaration");
		expect(resolve("src/special.d.ts")).toBe("special");
		expect(resolve("src\\types.d.ts")).toBe("declaration");
	});
	it("keeps ambiguous include extensions in the supplied registry and unknown files readable", () => {
		const resolve = createSourceLanguageResolver([{ id: "cpp", extensions: [".inc"] }]);
		expect(resolve("shared.inc")).toBe("cpp");
		for (const path of ["unknown.boa-unknown", "folder.rs/README", "", "file."]) {
			expect(resolveLanguage(path)).toBe("plaintext");
		}
	});
});
