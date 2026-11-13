/** Versioned, local-only collection snapshots and a portable Markdown representation. */
import type { CodeContext } from "./context-bubbles";

export type Point = { x: number; y: number };
/** Legacy comments omit confirmed; false or an empty comment is treated as a retained draft. */
export type Annotation = { id: string; message: string; point: Point | null; confirmed?: boolean };
export type TextItem = {
	id: string;
	kind: "text";
	context: CodeContext;
	message: string;
	wholeFile: boolean;
};
export type ImageItem = {
	id: string;
	kind: "image";
	project: string;
	path: string;
	sourceKey: string;
	dataUrl: string;
	width: number;
	height: number;
	annotations: Annotation[];
};
export type CollectionItem = TextItem | ImageItem;
export type CollectionDraft = { version: 1; active: boolean; instruction: string; items: CollectionItem[] };
export const emptyCollection = (): CollectionDraft => ({
	version: 1,
	active: false,
	instruction: "",
	items: [],
});
export const collectionLimits = {
	items: 100,
	annotations: 100,
	message: 20_000,
	excerpt: 100_000,
	bytes: 64 * 1024 * 1024,
};
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown, max = collectionLimits.message): value is string =>
	typeof value === "string" && value.length <= max;
const dimension = (value: unknown): value is number =>
	Number.isInteger(value) && Number(value) > 0 && Number(value) <= 8192;
const line = (value: unknown) => value === null || (Number.isInteger(value) && Number(value) > 0);
export function isPoint(value: unknown): value is Point {
	return (
		record(value) &&
		[value.x, value.y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
	);
}
export function isCollectionDraft(value: unknown): value is CollectionDraft {
	if (
		!record(value) ||
		value.version !== 1 ||
		typeof value.active !== "boolean" ||
		!string(value.instruction) ||
		!Array.isArray(value.items) ||
		value.items.length > collectionLimits.items
	)
		return false;
	const ids = new Set<string>();
	return value.items.every((item) => {
		if (!record(item) || !string(item.id, 100) || !item.id || ids.has(item.id)) return false;
		ids.add(item.id);
		if (item.kind === "text") {
			const c = item.context;
			return (
				string(item.message) &&
				typeof item.wholeFile === "boolean" &&
				record(c) &&
				string(c.project) &&
				string(c.path) &&
				string(c.label) &&
				string(c.code, collectionLimits.excerpt) &&
				line(c.startLine) &&
				line(c.endLine) &&
				(c.startLine === null
					? c.endLine === null
					: c.endLine !== null && Number(c.endLine) >= Number(c.startLine))
			);
		}
		if (
			item.kind !== "image" ||
			!string(item.project) ||
			!string(item.path) ||
			!string(item.sourceKey, 100) ||
			!string(item.dataUrl, 12_000_000) ||
			!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(item.dataUrl) ||
			!dimension(item.width) ||
			!dimension(item.height) ||
			item.width * item.height > 16_777_216 ||
			!Array.isArray(item.annotations) ||
			item.annotations.length > collectionLimits.annotations
		)
			return false;
		const annotations = new Set<string>();
		return item.annotations.every((a) => {
			if (
				!record(a) ||
				!string(a.id, 100) ||
				!a.id ||
				annotations.has(a.id) ||
				!string(a.message) ||
				(a.confirmed !== undefined && typeof a.confirmed !== "boolean") ||
				(a.point !== null && !isPoint(a.point))
			)
				return false;
			annotations.add(a.id);
			return true;
		});
	});
}
export const isAnnotationDraft = (annotation: Annotation): boolean =>
	annotation.confirmed === false || !annotation.message.trim();
export function hasUnconfirmedAnnotations(draft: CollectionDraft): boolean {
	return draft.items.some((item) => item.kind === "image" && item.annotations.some(isAnnotationDraft));
}
export function pointInImage(
	clientX: number,
	clientY: number,
	bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
): Point | null {
	if (!bounds.width || !bounds.height) return null;
	return {
		x: Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)),
		y: Math.max(0, Math.min(1, (clientY - bounds.top) / bounds.height)),
	};
}
export const imageExportName = (index: number) => `image-${index + 1}.png`;
function fence(text: string): string {
	const delimiter = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1)));
	return `${delimiter}\n${text}\n${delimiter}`;
}
export function collectionPrompt(draft: CollectionDraft, english: boolean): string {
	const parts = [`# ${english ? "Collected context" : "Contexte collecté"}`, draft.instruction.trim()];
	if (draft.items.some((item) => item.kind === "image"))
		parts.push(
			english
				? "Images are separate attachments. Attach the exported PNG files along with this message."
				: "Les images sont des pièces jointes séparées. Joindre les PNG exportés avec ce message.",
		);
	draft.items.forEach((item, index) => {
		if (item.kind === "text") {
			const c = item.context;
			parts.push(
				`## ${index + 1}. ${english ? "File" : "Fichier"}`,
				`${english ? "Project" : "Projet"}: ${c.project}\n${english ? "Path" : "Chemin"}: ${c.path}`,
				c.label,
			);
			if (!item.wholeFile && c.code) {
				if (c.startLine !== null) parts.push(`${english ? "Lines" : "Lignes"}: ${c.startLine}–${c.endLine}`);
				parts.push(fence(c.code));
			} else
				parts.push(
					english
						? "File reference only; contents are not included."
						: "Référence du fichier uniquement ; contenu non inclus.",
				);
			if (item.message.trim()) parts.push(item.message.trim());
		} else {
			parts.push(
				`## ${index + 1}. ${english ? "Image" : "Image"}`,
				`${english ? "Project" : "Projet"}: ${item.project}\n${english ? "Path" : "Chemin"}: ${item.path}`,
				`${english ? "Snapshot" : "Capture"}: ${item.width} × ${item.height} px`,
				`![${imageExportName(index)}](${imageExportName(index)})`,
			);
			item.annotations.forEach((a, n) =>
				parts.push(
					`${n + 1}. ${a.point ? `(${Math.round(a.point.x * 1000) / 10}%, ${Math.round(a.point.y * 1000) / 10}%)` : english ? "Whole image" : "Image entière"} — ${a.message}`,
				),
			);
		}
	});
	return parts.filter(Boolean).join("\n\n");
}
