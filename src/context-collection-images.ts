/** Image snapshots and export rendering are independent of the viewport and its zoom. */

import { annotationColors } from "./annotation-style";
import { type ImageItem, isAnnotationDraft } from "./context-collection-model";

export async function imageSourceKey(src: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
	return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}
export function snapshotImage(image: HTMLImageElement): { dataUrl: string; width: number; height: number } {
	const width = image.naturalWidth,
		height = image.naturalHeight;
	if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216)
		throw new Error("Unsupported snapshot dimensions");
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	try {
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		context.drawImage(image, 0, 0);
		const dataUrl = canvas.toDataURL("image/png");
		if (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > 12_000_000)
			throw new Error("Snapshot too large");
		return { dataUrl, width, height };
	} finally {
		canvas.width = 0;
		canvas.height = 0;
	}
}
function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		const timeout = setTimeout(() => {
			image.src = "";
			reject(new Error("Image decode timeout"));
		}, 10_000);
		image.onload = () => {
			clearTimeout(timeout);
			resolve(image);
		};
		image.onerror = () => {
			clearTimeout(timeout);
			reject(new Error("Image decode failed"));
		};
		image.src = src;
	});
}
/** Marker geometry is shared conceptually with the percentage-based overlay; numbers map to Markdown. */
export async function annotatedImage(item: ImageItem): Promise<string> {
	const image = await loadImage(item.dataUrl);
	const canvas = document.createElement("canvas");
	canvas.width = item.width;
	canvas.height = item.height;
	try {
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas unavailable");
		ctx.drawImage(image, 0, 0, item.width, item.height);
		const radius = Math.max(10, Math.min(32, Math.min(item.width, item.height) * 0.025));
		item.annotations.forEach((annotation, index) => {
			if (!annotation.point || isAnnotationDraft(annotation)) return;
			const x = annotation.point.x * item.width;
			const y = annotation.point.y * item.height;
			ctx.beginPath();
			ctx.arc(x, y, radius, 0, Math.PI * 2);
			ctx.fillStyle = annotationColors.pin;
			ctx.fill();
			ctx.strokeStyle = "#ffffff";
			ctx.lineWidth = Math.max(1, radius / 8);
			ctx.stroke();
			ctx.fillStyle = "#ffffff";
			ctx.font = `bold ${Math.round(radius * 1.2)}px system-ui`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.fillText(String(index + 1), x, y);
		});
		const result = canvas.toDataURL("image/png");
		if (!result.startsWith("data:image/png;base64,")) throw new Error("PNG export unavailable");
		return result;
	} finally {
		canvas.width = 0;
		canvas.height = 0;
	}
}
