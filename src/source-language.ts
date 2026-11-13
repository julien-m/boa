/** Filename metadata accepted from any local syntax registry; no editor SDK dependency. */
export interface SourceLanguageMetadata {
	readonly id: string;
	readonly extensions?: readonly string[];
	readonly filenames?: readonly string[];
}

const PLAIN_TEXT_LANGUAGE = "plaintext";
// Monaco's Pascal grammar covers Delphi source and the lexical structure of textual forms.
// .inc stays registry-owned: includes are also used by C/C++ and other languages.
const DELPHI_EXTENSIONS = [".dpr", ".dpk", ".dfm", ".fmx"] as const;

/** Prepare once after local grammars are registered; later registrations require a new resolver. */
export function createSourceLanguageResolver(
	registry: readonly SourceLanguageMetadata[],
): (path: string) => string {
	const filenames = new Map<string, string>();
	const extensions = new Map<string, string>();
	for (const language of registry) {
		for (const filename of language.filenames ?? []) filenames.set(filename.toLowerCase(), language.id);
		for (const extension of language.extensions ?? []) extensions.set(extension.toLowerCase(), language.id);
	}
	for (const extension of DELPHI_EXTENSIONS) extensions.set(extension, "pascal");
	// Longest suffix wins (.d.ts before .ts). Work is bounded by the installed registry,
	// with no filesystem reads, content inspection or per-render registry reconstruction.
	const suffixes = [...extensions].sort(([left], [right]) => right.length - left.length);
	return (path: string): string => {
		const basename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
		return (
			filenames.get(basename) ??
			suffixes.find(([suffix]) => basename.endsWith(suffix))?.[1] ??
			PLAIN_TEXT_LANGUAGE
		);
	};
}
