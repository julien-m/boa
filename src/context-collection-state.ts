/** Shared state contract for the collection provider and its controls. */
import { createContext, useContext } from "react";
import type {
	Annotation,
	CodeContext,
	CollectionDraft,
	CollectionItem,
	ImageItem,
} from "./context-collection-model";

export type Collection = {
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

export const CollectionContext = createContext<Collection | null>(null);

/** Returns the active collection when a provider owns this reader. */
export const useContextCollection = (): Collection | null => useContext(CollectionContext);
