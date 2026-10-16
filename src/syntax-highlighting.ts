/** Local lexical highlighting only: no language server or schema requests. */
import { languages } from "monaco-editor/editor/editor.api.js";

languages.register({ id: "json", extensions: [".json", ".jsonc"], aliases: ["JSON", "JSONC"] });
languages.setMonarchTokensProvider("json", {
	defaultToken: "",
	tokenPostfix: ".json",
	tokenizer: {
		root: [
			[/\s+/, "white"],
			[/\/\/.*$/, "comment"],
			[/\/\*/, "comment", "@comment"],
			[/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key"],
			[/"(?:[^"\\]|\\.)*"/, "string.value"],
			[/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
			[/\b(?:true|false|null)\b/, "keyword"],
			[/[{}\[\]]/, "delimiter.bracket"],
			[/[:,]/, "delimiter"],
		],
		comment: [
			[/[^*]+/, "comment"],
			[/\*\//, "comment", "@pop"],
			[/\*/, "comment"],
		],
	},
});

languages.register({ id: "toml", extensions: [".toml"], aliases: ["TOML"] });
languages.setMonarchTokensProvider("toml", {
	defaultToken: "",
	tokenPostfix: ".toml",
	tokenizer: {
		root: [
			[/\s+/, "white"],
			[/#.*/, "comment"],
			[/"""/, "string", "@multilineBasic"],
			[/'''/, "string", "@multilineLiteral"],
			[/"(?:[^"\\]|\\.)*"(?=\s*=)/, "key"],
			[/"(?:[^"\\]|\\.)*"/, "string"],
			[/'[^']*'/, "string"],
			[/\[\[?[^\]\n]+\]\]?/, "type.identifier"],
			[/[\w.-]+(?=\s*=)/, "key"],
			[/\b(?:true|false)\b/, "keyword"],
			[/[+-]?(?:\d[\w:.+-]*|inf|nan)/, "number"],
			[/[{}\[\],=]/, "delimiter"],
		],
		multilineBasic: [
			[/"""/, "string", "@pop"],
			[/\\./, "string.escape"],
			[/[^"\\]+/, "string"],
			[/./, "string"],
		],
		multilineLiteral: [
			[/'''/, "string", "@pop"],
			[/[^']+/, "string"],
			[/./, "string"],
		],
	},
});
