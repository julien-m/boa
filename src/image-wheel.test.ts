import { expect, it } from "vitest";
import { createImageTabNavigation, createImageWheelNavigation, tabNavigationDirection } from "./image-wheel";

const fitted = { scrollWidth: 800, clientWidth: 800, scrollHeight: 600, clientHeight: 600 };
const wheel = (timeStamp: number, deltaY: number, deltaX = 0) => ({
	timeStamp,
	deltaY,
	deltaX,
	deltaMode: 0,
	ctrlKey: false,
	metaKey: false,
	altKey: false,
});

it("requires accumulated wheel distance before changing images and discards idle or reversed motion", () => {
	const navigate = createImageWheelNavigation();
	for (const time of [0, 20])
		expect(navigate(wheel(time, 20), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(40, 20), fitted)).toEqual({ consume: true, direction: 1 });
	expect(navigate(wheel(300, 30), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(500, 30), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(520, -30), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(540, -30), fitted)).toEqual({ consume: true, direction: -1 });
});

it("bounds continuous wheel bursts without a sliding pause or queued inertia", () => {
	const navigate = createImageWheelNavigation();
	expect(navigate(wheel(0, 600), fitted)).toEqual({ consume: true, direction: 1 });
	for (let time = 10; time < 200; time += 10)
		expect(navigate(wheel(time, 600), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(200, 1), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(210, 59), fitted)).toEqual({ consume: true, direction: 1 });
	for (let time = 220; time < 410; time += 10)
		expect(navigate(wheel(time, 60), fitted)).toEqual({ consume: true, direction: 0 });
	expect(navigate(wheel(410, 60), fitted)).toEqual({ consume: true, direction: 1 });
});

it("normalizes line and page deltas and uses the dominant wheel axis", () => {
	const navigate = createImageWheelNavigation();
	expect(navigate({ ...wheel(0, 4), deltaMode: 1 }, fitted)).toEqual({ consume: true, direction: 1 });
	expect(navigate({ ...wheel(200, 0, -1), deltaMode: 2 }, fitted)).toEqual({ consume: true, direction: -1 });
});

it("preserves scrolling in an overflowing image and leaves pinch/modifier gestures untouched", () => {
	const navigate = createImageWheelNavigation();
	for (const surface of [
		{ ...fitted, scrollWidth: 1600 },
		{ ...fitted, scrollHeight: 1200 },
	]) {
		expect(navigate(wheel(0, 60), surface)).toEqual({ consume: false, direction: 0 });
	}
	for (const key of ["ctrlKey", "metaKey", "altKey"])
		expect(navigate({ ...wheel(0, 60), [key]: true }, fitted)).toEqual({ consume: false, direction: 0 });
	expect(navigate(wheel(0, 0), fitted)).toEqual({ consume: false, direction: 0 });
	expect(navigate(wheel(0, 60), fitted)).toEqual({ consume: true, direction: 1 });
});

it("does not extend the interval when the next image is loading and resumes as soon as it is ready", () => {
	const navigate = createImageWheelNavigation();
	expect(navigate(wheel(0, 60), fitted)).toEqual({ consume: true, direction: 1 });
	for (const time of [100, 200])
		expect(navigate(wheel(time, 20), fitted, false)).toEqual({ consume: false, direction: 0 });
	expect(navigate(wheel(300, 60), fitted)).toEqual({ consume: true, direction: 1 });
	expect(navigate(wheel(600, 60), fitted)).toEqual({ consume: true, direction: 1 });
	// The reader can temporarily have no viewport at all while awaiting native image data.
	expect(navigate(wheel(700, 20), null, false)).toEqual({ consume: false, direction: 0 });
	expect(navigate(wheel(900, 60), fitted)).toEqual({ consume: true, direction: 1 });
});

it("reserves only the chosen axis, even while a zoomed image scrolls on the other axis", () => {
	const navigate = createImageWheelNavigation({ axis: "horizontal", sensitivity: 5 });
	const tall = { ...fitted, scrollHeight: 1200 };
	expect(navigate(wheel(0, 80), tall)).toEqual({ consume: false, direction: 0 });
	expect(navigate(wheel(10, 0, 80), tall)).toEqual({ consume: true, direction: 1 });
	expect(navigate(wheel(300, 80, 2), tall)).toEqual({ consume: false, direction: 0 });
	expect(createImageWheelNavigation({ axis: "vertical", sensitivity: 5 })(wheel(0, 0, 80), fitted)).toEqual({
		consume: false,
		direction: 0,
	});
	expect(createImageWheelNavigation({ axis: "off", sensitivity: 5 })(wheel(0, 80), fitted)).toEqual({
		consume: false,
		direction: 0,
	});
});

it("makes both required distance and step rate adjustable without queueing movement", () => {
	const low = createImageWheelNavigation({ axis: "vertical", sensitivity: 2 });
	const high = createImageWheelNavigation({ axis: "vertical", sensitivity: 10 });
	expect(low(wheel(0, 60), fitted).direction).toBe(0);
	expect(high(wheel(0, 60), fitted).direction).toBe(1);
	expect(high(wheel(100, 60), fitted).direction).toBe(1);
	expect(low(wheel(100, 60), fitted).direction).toBe(0);
	expect(low(wheel(200, 60), fitted).direction).toBe(1);
});

it("accepts small isolated horizontal impulses instead of resetting them below an unreachable distance threshold", () => {
	const navigate = createImageWheelNavigation({ axis: "horizontal", sensitivity: 5 });
	for (const time of [0, 300, 600]) {
		expect(navigate(wheel(time, 0, 1), fitted)).toEqual({ consume: true, direction: 1 });
	}
	expect(navigate(wheel(900, 0, -1), fitted)).toEqual({ consume: true, direction: -1 });
	expect(navigate(wheel(910, 0, -1), fitted)).toEqual({ consume: true, direction: 0 });
});

const tab = (timeStamp: number, shiftKey = false) => ({
	key: "Tab",
	ctrlKey: true,
	shiftKey,
	metaKey: false,
	altKey: false,
	timeStamp,
});
it("uses Logitech browser-tab commands for image navigation with a fixed sensitivity interval", () => {
	const navigate = createImageTabNavigation({ axis: "tabs", sensitivity: 4 });
	expect(navigate(tab(0))).toEqual({ consume: true, direction: 1 });
	expect(navigate(tab(100))).toEqual({ consume: true, direction: 0 });
	expect(navigate(tab(300, true))).toEqual({ consume: true, direction: -1 });
	expect(navigate(tab(600), false)).toEqual({ consume: true, direction: 0 });
	expect(navigate(tab(700))).toEqual({ consume: true, direction: 1 });
	expect(createImageWheelNavigation({ axis: "tabs", sensitivity: 4 })(wheel(0, 80), fitted)).toEqual({
		consume: false,
		direction: 0,
	});
});
it("preserves ordinary Tab, system app switching and tab commands in other navigation modes", () => {
	expect(tabNavigationDirection({ ...tab(0), ctrlKey: false })).toBe(0);
	expect(tabNavigationDirection({ ...tab(0), ctrlKey: false, metaKey: true })).toBe(0);
	expect(tabNavigationDirection({ ...tab(0), altKey: true })).toBe(0);
	expect(tabNavigationDirection({ ...tab(0), key: "a" })).toBe(0);
	expect(createImageTabNavigation({ axis: "horizontal", sensitivity: 4 })(tab(0))).toEqual({
		consume: false,
		direction: 0,
	});
});
