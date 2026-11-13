/** Distance-gated wheel navigation with a fixed rate limit; native zoom/panning stays untouched. */
import {
	defaultImageWheelPreferences,
	type ImageWheelPreferences,
	isImageWheelPreferences,
} from "./image-wheel-preferences";

type WheelInput = Pick<
	WheelEvent,
	"deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "altKey" | "timeStamp"
>;
type Surface = Pick<HTMLElement, "scrollWidth" | "scrollHeight" | "clientWidth" | "clientHeight">;
type WheelDecision = { consume: boolean; direction: -1 | 0 | 1 };
type ImageWheelNavigation = (event: WheelInput, surface: Surface | null, ready?: boolean) => WheelDecision;

// Conservative tuning for the reported sensitive Logitech wheel, not physical device measurements:
// require deliberate distance and cap steps while discarding short residual motion between gestures.
const WHEEL_DISTANCE_THRESHOLD_PX = 60;
const WHEEL_STEP_INTERVAL_MS = 200;
const WHEEL_IDLE_RESET_MS = 180;
// Browser line deltas have no fixed pixel size; use a conventional text-line approximation.
const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Creates independent navigation state for one image viewport; no DOM mutation or timers.
 * @param preferences Saved axis and sensitivity; validated before preparing a controller.
 * @returns A callback accepting wheel data, viewport dimensions and readiness (default true).
 * It returns whether to consume the event and a step direction; zero means no image change.
 * Zoom/modifier and unready/missing viewports remain unconsumed. Both-axis mode preserves native panning; an explicit axis reserves that axis for navigation.
 */
export function createImageWheelNavigation(
	preferences: ImageWheelPreferences = defaultImageWheelPreferences,
): ImageWheelNavigation {
	if (!isImageWheelPreferences(preferences)) throw new RangeError("Invalid image wheel preferences");
	const { axis, sensitivity } = preferences;
	// Preserve the existing tuning at 5/10; higher values reduce distance and the fixed interval.
	const scale = defaultImageWheelPreferences.sensitivity / sensitivity;
	const stepInterval = WHEEL_STEP_INTERVAL_MS * scale;
	const distanceThreshold = WHEEL_DISTANCE_THRESHOLD_PX * scale;
	let lastStep = Number.NEGATIVE_INFINITY;
	let lastEvent = Number.NEGATIVE_INFINITY;
	let pendingDistance = 0;
	let lastDirection = 0;
	return (event: WheelInput, surface: Surface | null, ready = true): WheelDecision => {
		if (
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			axis === "off" ||
			axis === "tabs" ||
			(axis === "both" &&
				surface &&
				(surface.scrollWidth > surface.clientWidth || surface.scrollHeight > surface.clientHeight))
		)
			return { consume: false, direction: 0 };
		const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
		if ((axis === "horizontal" && !horizontal) || (axis === "vertical" && horizontal)) {
			pendingDistance = 0;
			return { consume: false, direction: 0 };
		}
		const delta = horizontal ? event.deltaX : event.deltaY;
		if (!Number.isFinite(delta) || !delta) return { consume: false, direction: 0 };
		if (!ready || !surface) return { consume: false, direction: 0 };
		const direction = delta > 0 ? 1 : -1;
		if (event.timeStamp - lastEvent >= WHEEL_IDLE_RESET_MS || direction !== lastDirection)
			pendingDistance = 0;
		lastEvent = event.timeStamp;
		lastDirection = direction;
		// Ignore motion during the fixed interval: a fast wheel must never queue future steps.
		if (event.timeStamp - lastStep < stepInterval) {
			pendingDistance = 0;
			return { consume: true, direction: 0 };
		}
		const unit =
			event.deltaMode === 1
				? WHEEL_LINE_HEIGHT_PX
				: event.deltaMode === 2
					? horizontal
						? surface.clientWidth
						: surface.clientHeight
					: 1;
		pendingDistance += Math.abs(delta) * unit;
		// Thumb wheels can emit isolated 1-pixel impulses: a distance threshold can make them inert.
		// Horizontal intent is axis-filtered above and rate-limited; distance gating stays vertical only.
		if (!horizontal && pendingDistance < distanceThreshold) return { consume: true, direction: 0 };
		pendingDistance = 0;
		lastStep = event.timeStamp;
		return { consume: true, direction };
	};
}

type TabInput = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey" | "timeStamp">;

/** Recognize browser-style tab commands; ordinary focus traversal and OS app switching stay untouched. */
export function tabNavigationDirection(event: TabInput): -1 | 0 | 1 {
	if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return 0;
	return event.shiftKey ? -1 : 1;
}

/** Prepare browser-style tab-command navigation; consume recognized commands during loading without queueing them. */
export function createImageTabNavigation(
	preferences: ImageWheelPreferences,
): (event: TabInput, ready?: boolean) => WheelDecision {
	if (!isImageWheelPreferences(preferences)) throw new RangeError("Invalid image wheel preferences");
	const enabled = preferences.axis === "tabs";
	const interval =
		(WHEEL_STEP_INTERVAL_MS * defaultImageWheelPreferences.sensitivity) / preferences.sensitivity;
	let lastStep = Number.NEGATIVE_INFINITY;
	return (event, ready = true) => {
		const direction = tabNavigationDirection(event);
		if (!enabled || !direction) return { consume: false, direction: 0 };
		if (!ready || event.timeStamp - lastStep < interval) return { consume: true, direction: 0 };
		lastStep = event.timeStamp;
		return { consume: true, direction };
	};
}
