/** Storage contract checks for wheel settings, independent of React and browser state. */
import { expect, it } from "vitest";
import { createWheelPreferenceStore, defaultImageWheelPreferences } from "./image-wheel-preferences";

it("restores validated settings and notifies only after a durable update", () => {
	let saved: string | null = null;
	const storage = {
		read: () => saved,
		write: (value: string) => {
			saved = value;
		},
	};
	const store = createWheelPreferenceStore(storage);
	expect(store.getSnapshot().preferences).toEqual(defaultImageWheelPreferences);
	let calls = 0;
	const unsubscribe = store.subscribe(() => {
		calls++;
		expect(JSON.parse(saved!).axis).toBe("horizontal");
	});
	store.set({ axis: "horizontal", sensitivity: 3 });
	expect(calls).toBe(1);
	expect(createWheelPreferenceStore(storage).getSnapshot().preferences).toEqual({
		axis: "horizontal",
		sensitivity: 3,
	});
	unsubscribe();
	store.set({ axis: "off", sensitivity: 5 });
	expect(calls).toBe(1);
});

it("rejects corrupt or out of range stored data and retains the snapshot on failed writes", () => {
	for (const value of [
		{ version: 2, axis: "both", sensitivity: 5 },
		{ version: 1, axis: "unknown", sensitivity: 5 },
		{ version: 1, axis: "both", sensitivity: 0 },
		{ version: 1, axis: "both", sensitivity: 11 },
		{ version: 1, axis: "both", sensitivity: 1.5 },
	]) {
		const store = createWheelPreferenceStore({ read: () => JSON.stringify(value), write: () => {} });
		expect(store.getSnapshot()).toEqual({ preferences: defaultImageWheelPreferences, status: "invalid" });
	}
	const store = createWheelPreferenceStore({
		read: () => null,
		write: () => {
			throw new Error("Storage blocked");
		},
	});
	const before = store.getSnapshot();
	expect(() => store.set({ axis: "vertical", sensitivity: 2 })).toThrow("Storage blocked");
	expect(store.getSnapshot()).toBe(before);
	expect(
		createWheelPreferenceStore({
			read: () => {
				throw new Error("Unavailable");
			},
			write: () => {},
		}).getSnapshot().status,
	).toBe("unavailable");
});

it("reports malformed saved JSON and rejects invalid updates without publishing", () => {
	expect(createWheelPreferenceStore({ read: () => "{", write: () => {} }).getSnapshot().status).toBe(
		"invalid",
	);
	const store = createWheelPreferenceStore({
		read: () => null,
		write: () => {
			throw new Error("Should not write");
		},
	});
	expect(() => store.set({ axis: "both", sensitivity: Number.NaN })).toThrow(RangeError);
	expect(store.getSnapshot().preferences).toEqual(defaultImageWheelPreferences);
});

it("restores tab-navigation mode without invalidating existing wheel modes", () => {
	for (const axis of ["tabs", "horizontal", "vertical", "both", "off"]) {
		const store = createWheelPreferenceStore({
			read: () => JSON.stringify({ version: 1, axis, sensitivity: 4 }),
			write: () => {},
		});
		expect(store.getSnapshot()).toEqual({ preferences: { axis, sensitivity: 4 }, status: "ready" });
	}
});
