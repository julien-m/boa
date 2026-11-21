/** Client-side preview of an action template while it is being edited (same syntax as the backend). */
export type TemplateValues = {
	project?: string | null;
	branch?: string | null;
	file?: string | null;
	selection?: string | null;
};

const VARIABLES: Record<string, keyof TemplateValues> = {
	projet: "project",
	project: "project",
	branche: "branch",
	branch: "branch",
	fichier: "file",
	file: "file",
	sélection: "selection",
	selection: "selection",
};

/** Matches `{{`, `}}` escapes and `{name}` placeholders; anything else stays literal. */
const TOKEN = /\{\{|\}\}|\{([^{}]*)\}/g;

/**
 * Replaces known variables with available values; unknown or missing ones stay visible as
 * `{name}` so the preview never hides a gap the backend would reject.
 */
export function previewTemplate(
	template: string,
	values: TemplateValues,
): { text: string; missing: string[] } {
	const missing = new Set<string>();
	const text = template.replace(TOKEN, (token: string, name: string | undefined) => {
		if (token === "{{") return "{";
		if (token === "}}") return "}";
		const key = name ? VARIABLES[name] : undefined;
		const value = key ? values[key] : undefined;
		if (value) return value;
		missing.add(name ?? "");
		return token;
	});
	return { text, missing: [...missing] };
}
