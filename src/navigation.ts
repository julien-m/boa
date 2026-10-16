/** Parses read-only navigation links used by the CLI and external assistants. */
export interface NavigationRequest {
	file: string;
	line: number;
	endLine: number;
	source: string;
}
export function parseNavigation(raw: string): NavigationRequest {
	const url = new URL(raw);
	if (url.protocol !== "boa:" || url.hostname !== "open") throw new Error("Lien BOA inconnu");
	const file = url.searchParams.get("file");
	const line = Number(url.searchParams.get("line") ?? "1");
	const endLine = Number(url.searchParams.get("endLine") ?? String(line));
	if (
		!file?.startsWith("/") ||
		!Number.isSafeInteger(line) ||
		line < 1 ||
		line > 1_000_000 ||
		!Number.isSafeInteger(endLine) ||
		endLine < line ||
		endLine > 1_000_000
	)
		throw new Error("Chemin ou lignes invalides dans le lien BOA");
	const source = url.searchParams.get("source") ?? "CLI";
	return {
		file,
		line,
		endLine,
		source: ["Codex", "Claude", "Cursor", "CLI"].includes(source) ? source : "CLI",
	};
}
