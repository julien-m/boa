/** Conservative relocation of passages after their source has changed. */
import type { ContextPassage, ContextStep, ContextView } from "./context-api";

export interface ResolvedContextPassage {
	line: number;
	endLine: number;
	status: "exact" | "relocated" | "needs-review";
}

const normalize = (text: string) => text.replace(/\r\n/g, "\n");
const lineAt = (content: string, offset: number) => content.slice(0, offset).split("\n").length;
const identifierCharacter = /[\p{L}\p{N}_$]/u;

function uniqueSymbolOffset(source: string, symbol: string): number {
	let found = -1;
	let cursor = 0;
	while (cursor < source.length) {
		const offset = source.indexOf(symbol, cursor);
		if (offset < 0) break;
		cursor = offset + symbol.length;
		if (
			(identifierCharacter.test(symbol[0]) && identifierCharacter.test(source[offset - 1] ?? "")) ||
			(identifierCharacter.test(symbol.at(-1) ?? "") &&
				identifierCharacter.test(source[offset + symbol.length] ?? ""))
		)
			continue;
		if (found >= 0) return -1;
		found = offset;
	}
	return found;
}

export function resolveContextPassage(content: string, passage: ContextPassage): ResolvedContextPassage {
	const source = normalize(content);
	const result = { line: passage.startLine, endLine: passage.endLine };
	const stale = (): ResolvedContextPassage => ({ ...result, status: "needs-review" });
	const lineCount = source.split("\n").length;
	const valid =
		Number.isSafeInteger(passage.startLine) &&
		Number.isSafeInteger(passage.endLine) &&
		passage.startLine >= 1 &&
		passage.endLine >= passage.startLine &&
		passage.endLine <= lineCount;
	if (passage.text) {
		const anchor = normalize(passage.text);
		const offset = source.indexOf(anchor);
		// Repeated text is ambiguous even when one occurrence is at the old coordinates.
		if (offset < 0 || source.indexOf(anchor, offset + 1) >= 0) return stale();
		const line = lineAt(source, offset);
		const endLine = lineAt(source, offset + anchor.length - (anchor.endsWith("\n") ? 1 : 0));
		return {
			line,
			endLine,
			status: line === passage.startLine && endLine === passage.endLine ? "exact" : "relocated",
		};
	}
	if (!valid) return stale();
	if (passage.symbol) {
		const offset = uniqueSymbolOffset(source, passage.symbol);
		if (offset < 0) return stale();
		const line = lineAt(source, offset);
		// A symbol alone cannot reconstruct a range when it has moved.
		if (line < passage.startLine || line > passage.endLine) return stale();
	}
	return { ...result, status: "exact" };
}

/** Stable IDs retain a selected step across updates; deletion never opens a different step. */
export function currentContextStep(view: ContextView | null, stepId?: string): ContextStep | null {
	return view?.steps.find((step) => step.id === stepId) ?? null;
}
