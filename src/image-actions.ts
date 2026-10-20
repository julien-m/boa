export type ImageAction = "fullscreen" | "compare";
let pending: { project: string; path: string; action: ImageAction; expires: number } | null = null;

export function requestImageAction(project: string, path: string, action: ImageAction): void {
	pending = { project, path, action, expires: Date.now() + 10_000 };
	window.dispatchEvent(new CustomEvent("boa:image-action", { detail: { project, path, action } }));
}

export function consumeImageAction(project: string, path: string): ImageAction | null {
	if (pending && pending.expires <= Date.now()) pending = null;
	if (!pending || pending.project !== project || pending.path !== path) return null;
	const action = pending.action;
	pending = null;
	return action;
}
