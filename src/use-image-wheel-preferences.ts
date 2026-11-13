/** Browser storage composition and React subscription for the shared wheel preference store. */
import { useSyncExternalStore } from "react";
import {
	createWheelPreferenceStore,
	type ImageWheelPreferences,
	type WheelPreferenceSnapshot,
} from "./image-wheel-preferences";

const STORAGE_KEY = "boa-image-wheel-preferences";
const store = createWheelPreferenceStore({
	read: () => localStorage.getItem(STORAGE_KEY),
	write: (value) => localStorage.setItem(STORAGE_KEY, value),
});

/** Subscribe to saved settings; updates persist synchronously or throw without changing the current snapshot. */
export function useImageWheelPreferences(): WheelPreferenceSnapshot & {
	setPreferences: (preferences: ImageWheelPreferences) => void;
} {
	return { ...useSyncExternalStore(store.subscribe, store.getSnapshot), setPreferences: store.set };
}
