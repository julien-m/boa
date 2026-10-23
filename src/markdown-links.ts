/** Resolve local Markdown destinations without changing the document's registered scope. */
export function localMarkdownLink(href: string, document: string): { file: string; anchor: string } | null {
	if (href.startsWith("//") || (/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith("file:"))) return null;
	try {
		const base = new URL("file:///");
		base.pathname = document.split("/").map(encodeURIComponent).join("/");
		const target = new URL(href, base);
		if (target.protocol !== "file:" || target.hostname) return null;
		return { file: decodeURIComponent(target.pathname), anchor: decodeURIComponent(target.hash.slice(1)) };
	} catch {
		return null;
	}
}

type HeadingNode = {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HeadingNode[];
};
const text = (node: HeadingNode): string =>
	node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(text).join("");

/** Runs after sanitization: generated IDs are text-only and deterministic per document. */
export function headingAnchors() {
	return (tree: HeadingNode) => {
		const used = new Set<string>();
		const visit = (node: HeadingNode) => {
			if (/^h[1-6]$/.test(node.tagName ?? "")) {
				const slug = text(node)
					.toLowerCase()
					.replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, "")
					.replace(/\s/g, "-");
				let id = typeof node.properties?.id === "string" ? node.properties.id : slug;
				let suffix = 0;
				while (used.has(id)) id = `${slug}-${++suffix}`;
				used.add(id);
				node.properties = { ...node.properties, id };
			}
			for (const child of node.children ?? []) visit(child);
		};
		visit(tree);
	};
}
