/** OS event subscriptions must serialize opens and release listeners even during startup. */
import { beforeEach, expect, it, vi } from "vitest";
import { subscribeNativeOpenings } from "./native-openings";

const native = vi.hoisted(() => ({ listen: vi.fn(), onOpenUrl: vi.fn(), getCurrent: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen, TauriEvent: { DRAG_DROP: "drop" } }));
vi.mock("@tauri-apps/plugin-deep-link", () => native);

beforeEach(() => {
	vi.resetAllMocks();
	native.listen.mockResolvedValue(vi.fn());
	native.onOpenUrl.mockResolvedValue(vi.fn());
	native.getCurrent.mockResolvedValue(null);
});

it("serializes drop batches and keeps processing after an opening fails", async () => {
	let release = () => {};
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const open = vi
		.fn()
		.mockReturnValueOnce(pending)
		.mockRejectedValueOnce(new Error("unavailable"))
		.mockResolvedValue(undefined);
	const error = vi.fn();
	const stop = subscribeNativeOpenings(open, error);
	await vi.waitFor(() => expect(native.getCurrent).toHaveBeenCalled(), { timeout: 1000, interval: 5 });
	const drop = native.listen.mock.calls[0][1];
	for (const path of ["/one.md", "/two.md", "/three.md"]) drop({ payload: { paths: [path] } });
	await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 5 });
	release();
	await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(3), { timeout: 1000, interval: 5 });
	expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: "unavailable" }));
	stop();
	expect(await native.listen.mock.results[0].value).toHaveBeenCalledOnce();
	expect(await native.onOpenUrl.mock.results[0].value).toHaveBeenCalledOnce();
});

it("disposes a late listener and stops subscribing when unmounted during registration", async () => {
	let registered: (stop: () => void) => void = () => {};
	native.listen.mockReturnValue(
		new Promise<() => void>((resolve) => {
			registered = resolve;
		}),
	);
	const open = vi.fn();
	const stop = subscribeNativeOpenings(open, vi.fn());
	stop();
	const unlisten = vi.fn();
	registered(unlisten);
	await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce(), { timeout: 1000, interval: 5 });
	expect(native.onOpenUrl).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
});
