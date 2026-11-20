/**
 * Application-level dock state: open session tabs, the selected one, per-session view, drafts
 * and scroll positions. Closing a tab only hides its view: sessions and BOA terminals go on.
 * It lives above every view, so navigating files, projects or settings never resets it.
 * Drafts persist in this Mac's webview storage, shared by the main and detached windows.
 */
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { keyId, type PermissionRequest, type SessionKey, sameKey, sessionsApi } from "./sessions-api";

const STORAGE_KEY = "boa-session-dock";
/** Drafts are notes in progress; 50 sessions × 100 kB keeps storage far below webview quotas. */
const MAX_DRAFTS = 50;
const MAX_DRAFT_CHARS = 100_000;
/** Open tabs and remembered views stay small: a dock is a working set, not a history. */
const MAX_TABS = 12;
const MAX_VIEWS = 100;
const PERMISSION_EVENTS = new Set([
	"permissionRequest",
	"permissionResolved",
	"turnCompleted",
	"sessionClosed",
	"claudeBridgeClosed",
]);

export type DockView = "conversation" | "terminal";

type Persisted = {
	version: 2;
	/** Open tabs in display order; `current` is one of them or null. */
	tabs: SessionKey[];
	current: SessionKey | null;
	/** Last view chosen per session (`keyId`), kept after its tab closes. */
	views: Record<string, DockView>;
	open: boolean;
	collapsed: boolean;
	detached: boolean;
	drafts: Record<string, string>;
};

const EMPTY: Persisted = {
	version: 2,
	tabs: [],
	current: null,
	views: {},
	open: false,
	collapsed: false,
	detached: false,
	drafts: {},
};

function isKey(value: unknown): value is SessionKey {
	const key = value as SessionKey | null;
	return (
		!!key &&
		(key.provider === "codex" || key.provider === "claude") &&
		typeof key.id === "string" &&
		key.id.length > 0
	);
}

function uniqueKeys(values: unknown[]): SessionKey[] {
	const keys: SessionKey[] = [];
	for (const value of values)
		if (isKey(value) && !keys.some((key) => sameKey(key, value)))
			keys.push({ provider: value.provider, id: value.id });
	return keys.slice(0, MAX_TABS);
}

function stringRecord<T extends string>(
	value: unknown,
	accept: (item: unknown) => item is T,
): Record<string, T> {
	const result: Record<string, T> = {};
	if (value && typeof value === "object")
		for (const [id, item] of Object.entries(value)) if (accept(item)) result[id] = item;
	return result;
}

/**
 * Validates stored state and migrates v1 (`current` + `recent`, no tabs): the docked session
 * and recent ones become tabs in that order; drafts and window flags are kept.
 */
export function migrateDock(raw: unknown): Persisted {
	if (!raw || typeof raw !== "object") return EMPTY;
	const value = raw as Record<string, unknown>;
	const legacy = value.version !== 2;
	const tabs = uniqueKeys(
		legacy
			? [value.current, ...(Array.isArray(value.recent) ? value.recent : [])]
			: ((value.tabs as unknown[]) ?? []),
	);
	const current = isKey(value.current)
		? (tabs.find((tab) => sameKey(tab, value.current as SessionKey)) ?? null)
		: null;
	return {
		version: 2,
		tabs,
		current: current ?? tabs[0] ?? null,
		views: stringRecord(
			value.views,
			(item): item is DockView => item === "conversation" || item === "terminal",
		),
		open: value.open === true && tabs.length > 0,
		collapsed: value.collapsed === true,
		detached: value.detached === true,
		drafts: stringRecord(value.drafts, (item): item is string => typeof item === "string"),
	};
}

function read(): Persisted {
	try {
		const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
		return raw ? migrateDock(JSON.parse(raw)) : EMPTY;
	} catch {
		// Unreadable or blocked storage: start with an empty dock rather than failing the app.
		return EMPTY;
	}
}

function write(value: Persisted): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Storage full or blocked: the dock keeps working in memory for this window.
	}
}

type ComposerFeedback = { text: string; error: boolean };

export type DockState = Persisted & {
	permissions: PermissionRequest[];
	/** Opens `key` in a tab, or selects its existing tab: never a duplicate. */
	show: (key: SessionKey) => void;
	/** Closes the tab only: the session, its BOA terminal, draft, scroll and view stay. */
	closeTab: (key: SessionKey) => void;
	viewFor: (key: SessionKey | null) => DockView;
	setView: (key: SessionKey, view: DockView) => void;
	setOpen: (open: boolean) => void;
	setCollapsed: (collapsed: boolean) => void;
	setDetached: (detached: boolean) => void;
	draftFor: (key: SessionKey | null) => string;
	setDraft: (key: SessionKey, text: string) => void;
	/** Clears the draft of `key` only if it still equals `expected` (edited text survives). */
	clearDraftIf: (key: SessionKey, expected: string) => void;
	composerFeedbackFor: (key: SessionKey) => ComposerFeedback | undefined;
	setComposerFeedback: (key: SessionKey, feedback: ComposerFeedback | null) => void;
	scrollFor: (key: SessionKey) => number;
	setScroll: (key: SessionKey, top: number) => void;
};

const DockContext = createContext<DockState | null>(null);

/** Whether the explicit detached dock window currently exists (Tauri window registry). */
async function detachedWindowExists(): Promise<boolean> {
	try {
		const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
		return (await WebviewWindow.getByLabel("session-dock")) !== null;
	} catch {
		// Outside Tauri (tests, browser preview) there is no detached window to keep.
		return false;
	}
}

export function SessionDockProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<Persisted>(read);
	const [scrolls] = useState(() => new Map<string, number>());
	const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
	const [composerFeedback, setComposerFeedback] = useState(() => new Map<string, ComposerFeedback>());
	const queryClient = useQueryClient();

	const update = useCallback((change: (current: Persisted) => Persisted) => {
		setState((current) => {
			const next = change(current);
			write(next);
			return next;
		});
	}, []);

	useEffect(() => {
		// Other windows (detached dock) change the same storage: follow them.
		const onStorage = (event: StorageEvent) => {
			if (event.key === STORAGE_KEY) setState(read());
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	useEffect(() => {
		let active = true;
		let dispose: (() => void) | null = null;
		let latestRefresh = 0;
		const refresh = async () => {
			const revision = ++latestRefresh;
			try {
				const prompts = await sessionsApi.pendingPermissions();
				// A slow mount snapshot may predate an answer from the other window.
				if (active && revision === latestRefresh) setPermissions(prompts);
			} catch {
				// Browser previews have no native snapshot. In BOA a failed read leaves the last view intact.
			}
		};
		const subscribe = async () => {
			try {
				const stop = await listen<{ event: string }>("boa:session-event", ({ payload }) => {
					if (active && PERMISSION_EVENTS.has(payload.event)) void refresh();
				});
				if (!active) {
					stop();
					return;
				}
				dispose = stop;
				// Subscribe first to cover any change after the initial snapshot was taken.
				await refresh();
			} catch {
				// Outside Tauri (tests without IPC and browser previews) there is no native event source.
			}
		};
		void subscribe();
		return () => {
			active = false;
			dispose?.();
		};
	}, []);

	useEffect(() => {
		// Main window only: a detached flag without its window (crash, restart, closed elsewhere)
		// is orphaned; reattach so the dock shows again. Drafts are a separate field and stay.
		if (!state.detached || window.location.search.includes("window=session-dock")) return;
		let cancelled = false;
		void detachedWindowExists().then((exists) => {
			if (!cancelled && !exists) update((current) => ({ ...current, detached: false }));
		});
		return () => {
			cancelled = true;
		};
	}, [state.detached, update]);

	useEffect(() => {
		let active = true;
		const disposers: Array<() => void> = [];
		const refresh = () => {
			void queryClient.invalidateQueries({ queryKey: ["sessions"] });
		};
		for (const event of ["boa:sessions-changed", "boa:session-event"]) {
			void listen(event, refresh)
				.then((dispose) => (active ? disposers.push(dispose) : dispose()))
				.catch(() => undefined);
		}
		return () => {
			active = false;
			for (const dispose of disposers) dispose();
		};
	}, [queryClient]);

	const value = useMemo<DockState>(
		() => ({
			...state,
			permissions,
			show: (key) =>
				update((current) => {
					const exists = current.tabs.some((tab) => sameKey(tab, key));
					// A new tab goes last; past the bound the oldest unselected tab makes room.
					const tabs = exists ? current.tabs : [...current.tabs, key];
					const bounded = tabs.length > MAX_TABS ? tabs.filter((_, index) => index !== 0) : tabs;
					return { ...current, tabs: bounded, current: key, open: true, collapsed: false };
				}),
			closeTab: (key) =>
				update((current) => {
					const index = current.tabs.findIndex((tab) => sameKey(tab, key));
					if (index < 0) return current;
					const tabs = current.tabs.filter((_, position) => position !== index);
					const selected = sameKey(current.current, key)
						? (tabs[Math.min(index, tabs.length - 1)] ?? null)
						: current.current;
					return { ...current, tabs, current: selected, open: current.open && tabs.length > 0 };
				}),
			viewFor: (key) => (key ? (state.views[keyId(key)] ?? "conversation") : "conversation"),
			setView: (key, view) =>
				update((current) => {
					const views = { ...current.views };
					delete views[keyId(key)];
					views[keyId(key)] = view;
					const ids = Object.keys(views);
					for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_VIEWS))) delete views[stale];
					return { ...current, views };
				}),
			setOpen: (open) => update((current) => ({ ...current, open })),
			setCollapsed: (collapsed) => update((current) => ({ ...current, collapsed })),
			setDetached: (detached) => update((current) => ({ ...current, detached })),
			draftFor: (key) => (key ? (state.drafts[keyId(key)] ?? "") : ""),
			setDraft: (key, text) =>
				update((current) => {
					const drafts = { ...current.drafts };
					const id = keyId(key);
					if (text) drafts[id] = text.slice(0, MAX_DRAFT_CHARS);
					else delete drafts[id];
					const ids = Object.keys(drafts);
					// Oldest drafts beyond the bound are dropped first (insertion order).
					for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_DRAFTS))) delete drafts[stale];
					return { ...current, drafts };
				}),
			clearDraftIf: (key, expected) =>
				update((current) => {
					const id = keyId(key);
					// Compare-and-clear on the latest state, not on a value captured at click time.
					if (current.drafts[id] !== expected) return current;
					const drafts = { ...current.drafts };
					delete drafts[id];
					return { ...current, drafts };
				}),
			composerFeedbackFor: (key) => composerFeedback.get(keyId(key)),
			setComposerFeedback: (key, feedback) =>
				setComposerFeedback((current) => {
					const updated = new Map(current);
					updated.delete(keyId(key));
					if (feedback) updated.set(keyId(key), feedback);
					const oldest = updated.keys().next().value;
					if (updated.size > MAX_DRAFTS && oldest !== undefined) updated.delete(oldest);
					return updated;
				}),
			scrollFor: (key) => scrolls.get(keyId(key)) ?? -1,
			setScroll: (key, top) => {
				scrolls.set(keyId(key), top);
			},
		}),
		[state, update, scrolls, permissions, composerFeedback],
	);
	return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

/** For surfaces reused outside the app shell (tests, embeds): null without a dock provider. */
export function useOptionalSessionDock(): DockState | null {
	return useContext(DockContext);
}

export function useSessionDock(): DockState {
	const value = useContext(DockContext);
	if (!value) throw new Error("useSessionDock requires SessionDockProvider");
	return value;
}
