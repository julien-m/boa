/** One app-scoped draft; native saves are serialized and coalesce obsolete revisions. */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type CodeContext, ContextBubbles } from "./context-bubbles";
import { collectionApi } from "./context-collection-api";
import { useCollectionLabels } from "./context-collection-labels";
import {
	type Annotation,
	type CollectionDraft,
	type CollectionItem,
	collectionLimits,
	emptyCollection,
	type ImageItem,
	isCollectionDraft,
} from "./context-collection-model";
import { CollectionPanel } from "./context-collection-panel";
import "./context-collection.css";

type Collection = {
	draft: CollectionDraft;
	ready: boolean;
	saving: boolean;
	error: string;
	loadError: boolean;
	annotating: boolean;
	setAnnotating: (value: boolean) => void;
	show: () => void;
	annotate: (context: CodeContext, anchor?: { top: number; right: number }) => void;
	change: (update: (draft: CollectionDraft) => CollectionDraft) => void;
	addText: (context: CodeContext, message: string, wholeFile: boolean) => void;
	addImage: (image: Omit<ImageItem, "id" | "kind" | "annotations">, annotation: Annotation) => void;
	patchItem: (id: string, update: (item: CollectionItem) => CollectionItem) => void;
	retry: () => void;
};
const CollectionContext = createContext<Collection | null>(null);
export const useContextCollection = () => useContext(CollectionContext);

export function ContextCollectionProvider({ children }: { children: ReactNode }) {
	const l = useCollectionLabels();
	const [draft, setDraft] = useState(emptyCollection);
	const current = useRef(draft);
	const [ready, setReady] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const [open, setOpen] = useState(false);
	const [annotating, setAnnotating] = useState(false);
	const [annotationRequest, setAnnotationRequest] = useState<{
		id: string;
		context: CodeContext;
		anchor?: { top: number; right: number };
	}>();
	const [loadAttempt, setLoadAttempt] = useState(0);
	const revision = useRef(0);
	const unsaved = useRef(false);
	const queue = useRef(Promise.resolve());
	useEffect(() => {
		let cancelled = false;
		setLoadError(false);
		void collectionApi
			.load()
			.then((value) => {
				if (cancelled) return;
				if (value !== null && !isCollectionDraft(value)) throw new Error("Invalid collection draft");
				current.current = value ?? emptyCollection();
				setDraft(current.current);
				setReady(true);
				setError("");
			})
			.catch((reason: unknown) => {
				if (!cancelled) {
					setLoadError(true);
					setError(String(reason));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [loadAttempt]);
	const persist = (next: CollectionDraft) => {
		const savingRevision = ++revision.current;
		unsaved.current = true;
		setSaving(true);
		queue.current = queue.current
			.catch(() => {})
			.then(async () => {
				if (savingRevision !== revision.current) return;
				try {
					await collectionApi.save(next);
					if (savingRevision === revision.current) {
						unsaved.current = false;
						setError("");
					}
				} catch (reason) {
					if (savingRevision === revision.current) setError(String(reason));
				} finally {
					if (savingRevision === revision.current) setSaving(false);
				}
			});
	};
	const change: Collection["change"] = (update) => {
		if (!ready) throw new Error(l.loadFailed);
		const next = update(current.current);
		if (
			!isCollectionDraft(next) ||
			new TextEncoder().encode(JSON.stringify(next)).length > collectionLimits.bytes
		)
			throw new Error(l.limit);
		current.current = next;
		setDraft(next);
		persist(next);
	};
	useEffect(() => {
		const unload = (event: BeforeUnloadEvent) => {
			if (unsaved.current) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		const unlisten = getCurrentWindow().onCloseRequested((event) => {
			if (unsaved.current) {
				event.preventDefault();
				setOpen(true);
			}
		});
		window.addEventListener("beforeunload", unload);
		return () => {
			window.removeEventListener("beforeunload", unload);
			void unlisten.then((stop) => stop()).catch(() => {});
		};
	}, []);
	const value: Collection = {
		draft,
		ready,
		saving,
		error,
		loadError,
		annotating,
		setAnnotating,
		show: () => setOpen(true),
		annotate: (context, anchor) =>
			setAnnotationRequest({ id: crypto.randomUUID(), context: { ...context }, anchor }),
		change,
		retry: () => (ready ? persist(current.current) : setLoadAttempt((n) => n + 1)),
		addText: (context, message, wholeFile) =>
			change((all) => ({
				...all,
				active: true,
				items: [
					...all.items,
					{
						id: crypto.randomUUID(),
						kind: "text",
						context: wholeFile ? { ...context, code: "", startLine: null, endLine: null } : { ...context },
						message,
						wholeFile,
					},
				],
			})),
		addImage: (image, annotation) =>
			change((all) => {
				const existing = all.items.find(
					(item) =>
						item.kind === "image" &&
						item.project === image.project &&
						item.path === image.path &&
						item.sourceKey === image.sourceKey,
				);
				return {
					...all,
					active: true,
					items: existing
						? all.items.map((item) =>
								item === existing && item.kind === "image"
									? { ...item, annotations: [...item.annotations, annotation] }
									: item,
							)
						: [...all.items, { ...image, id: crypto.randomUUID(), kind: "image", annotations: [annotation] }],
				};
			}),
		patchItem: (id, update) =>
			change((all) => ({ ...all, items: all.items.map((item) => (item.id === id ? update(item) : item)) })),
	};
	return (
		<CollectionContext.Provider value={value}>
			{children}
			<ContextBubbles capture={() => null} context={null} externalRequest={annotationRequest} hideTrigger />
			{open && <CollectionPanel onClose={() => setOpen(false)} />}
		</CollectionContext.Provider>
	);
}

export function CollectionIndicator() {
	const c = useContextCollection();
	const l = useCollectionLabels();
	if (!c) return null;
	return (
		<button
			type="button"
			className="quiet-button collection-indicator"
			data-testid="collection-indicator"
			onClick={c.show}
			title={c.error ? l.unsaved : c.saving ? l.saving : l.saved}
		>
			{c.draft.items.length ? `${l.title} · ${c.draft.items.length}` : l.title}
			{c.error ? " !" : c.saving ? " …" : ""}
		</button>
	);
}
