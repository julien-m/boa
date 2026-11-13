/** Native persistence/export boundary. No content is transmitted to a network service. */
import { invoke } from "@tauri-apps/api/core";
import type { CollectionDraft } from "./context-collection-model";

export const collectionApi = {
	load: (): Promise<unknown> => invoke("context_collection_load"),
	save: (draft: CollectionDraft): Promise<void> => invoke("context_collection_save", { draft }),
	export: (
		prompt: string,
		images: { name: string; dataUrl: string }[],
	): Promise<{ directory: string; markdownPath: string; imagePaths: string[] } | null> =>
		invoke("context_collection_export", { prompt, images }),
};
