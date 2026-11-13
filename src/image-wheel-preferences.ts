/** Validated, local wheel preferences with an injected storage boundary and stable snapshots. */
export type ImageWheelAxis = "vertical" | "horizontal" | "both" | "off" | "tabs";
export interface ImageWheelPreferences {
	readonly axis: ImageWheelAxis;
	readonly sensitivity: number;
}
export const defaultImageWheelPreferences: ImageWheelPreferences = Object.freeze({
	axis: "both",
	sensitivity: 5,
});
export const imageWheelSensitivity = { min: 1, max: 10 } as const;
export interface WheelPreferenceSnapshot {
	readonly preferences: ImageWheelPreferences;
	readonly status: "ready" | "invalid" | "unavailable";
}
export interface WheelPreferenceStorage {
	read(): string | null;
	write(value: string): void;
}

/** Validate all externally supplied choices, including numeric range and closed axis values. */
export function isImageWheelPreferences(value: unknown): value is ImageWheelPreferences {
	if (!value || typeof value !== "object") return false;
	const data = value as Record<string, unknown>;
	return (
		typeof data.axis === "string" &&
		["vertical", "horizontal", "both", "off", "tabs"].includes(data.axis) &&
		typeof data.sensitivity === "number" &&
		Number.isInteger(data.sensitivity) &&
		data.sensitivity >= imageWheelSensitivity.min &&
		data.sensitivity <= imageWheelSensitivity.max
	);
}

/** One immutable saved snapshot, with explicit subscription ownership and synchronous updates. */
export interface WheelPreferenceStore {
	getSnapshot(): WheelPreferenceSnapshot;
	subscribe(listener: () => void): () => void;
	set(preferences: ImageWheelPreferences): void;
}
/** Load once; persist before notifying subscribers. Failed writes throw and preserve the previous snapshot. */
export function createWheelPreferenceStore(storage: WheelPreferenceStorage): WheelPreferenceStore {
	let snapshot: WheelPreferenceSnapshot = { preferences: defaultImageWheelPreferences, status: "ready" };
	try {
		const raw = storage.read();
		if (raw !== null) {
			const value: unknown = JSON.parse(raw);
			if (
				value &&
				typeof value === "object" &&
				"version" in value &&
				value.version === 1 &&
				isImageWheelPreferences(value)
			) {
				snapshot = {
					preferences: Object.freeze({ axis: value.axis, sensitivity: value.sensitivity }),
					status: "ready",
				};
			} else snapshot = { ...snapshot, status: "invalid" };
		}
	} catch (reason) {
		// Keep navigation usable with defaults, while exposing invalid JSON or a storage failure in Settings.
		snapshot = { ...snapshot, status: reason instanceof SyntaxError ? "invalid" : "unavailable" };
	}
	const subscribers = new Set<() => void>();
	return {
		getSnapshot: (): WheelPreferenceSnapshot => snapshot,
		subscribe: (listener: () => void): (() => void) => {
			subscribers.add(listener);
			return () => {
				subscribers.delete(listener);
			};
		},
		set: (preferences: ImageWheelPreferences): void => {
			if (!isImageWheelPreferences(preferences)) throw new RangeError("Invalid image wheel preferences");
			const next = Object.freeze({ axis: preferences.axis, sensitivity: preferences.sensitivity });
			storage.write(JSON.stringify({ version: 1, ...next }));
			snapshot = { preferences: next, status: "ready" };
			for (const listener of subscribers) listener();
		},
	};
}
