/** Serializes explicit OS openings and releases all native event listeners on disposal. */
import { listen, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { localFileUrl } from "./navigation";

// Match the existing file-space entry limit and bound each native opening batch.
const MAX_OPEN_ITEMS = 64;

/** Subscribe to Finder/Dock opens and native file drops; return an immediate, race-safe disposer. */
export function subscribeNativeOpenings(
	onOpen: (urls: string[]) => Promise<void>,
	onError: (error: unknown) => void,
): () => void {
	let disposed = false;
	let pending = Promise.resolve();
	const subscriptions: UnlistenFn[] = [];
	const enqueue = (urls: string[]): void => {
		if (disposed) return;
		if (urls.length > MAX_OPEN_ITEMS) {
			onError("Open at most 64 files or folders at once");
			return;
		}
		pending = pending
			.then(async () => {
				if (!disposed) await onOpen(urls);
			})
			.catch((error: unknown) => {
				if (!disposed) onError(error);
			});
	};
	const track = (stop: UnlistenFn): boolean => {
		if (disposed) {
			stop();
			return false;
		}
		subscriptions.push(stop);
		return true;
	};
	void (async () => {
		// Native drops expose real OS paths; browser File objects deliberately hide them.
		if (
			!track(
				await listen<{ paths: string[] }>(TauriEvent.DRAG_DROP, (event) => {
					enqueue(event.payload.paths.map(localFileUrl));
				}),
			)
		)
			return;
		if (!track(await onOpenUrl(enqueue))) return;
		const urls = await getCurrent();
		if (urls) enqueue(urls);
	})().catch((error: unknown) => {
		if (!disposed) onError(error);
	});
	return () => {
		disposed = true;
		for (const stop of subscriptions) stop();
		subscriptions.length = 0;
	};
}
