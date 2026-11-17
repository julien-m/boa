/** One native close decision, shared by every unsaved-draft owner. */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";

const CLOSE_GUARD_EVENT = "boa:before-window-close";

/** Register a synchronous veto; the owner also reveals its existing recovery controls. */
export function useWindowCloseGuard(guard: (event: Event) => void): void {
	const current = useRef(guard);
	current.current = guard;
	useEffect(() => {
		const check = (event: Event) => current.current(event);
		window.addEventListener(CLOSE_GUARD_EVENT, check);
		return () => window.removeEventListener(CLOSE_GUARD_EVENT, check);
	}, []);
}

/** Tauri destroys a window after each non-vetoed handler, so there must be only one. */
export function WindowCloseGuard() {
	useEffect(() => {
		let disposed = false;
		const unlisten = getCurrentWindow().onCloseRequested((event) => {
			if (disposed) {
				// An async registration may complete after StrictMode has replaced this owner.
				event.preventDefault();
				return;
			}
			const decision = new Event(CLOSE_GUARD_EVENT, { cancelable: true });
			window.dispatchEvent(decision);
			if (decision.defaultPrevented) event.preventDefault();
		});
		void unlisten.catch((error: unknown) =>
			console.error("Failed to register window close protection", error),
		);
		return () => {
			disposed = true;
			void unlisten
				.then((stop) => stop())
				.catch(() => {
					// Registration failures are reported above; a destroyed window needs no unlisten.
				});
		};
	}, []);
	return null;
}
