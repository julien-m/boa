import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { createFilesystemRefresh, projectSummaryOptions } from "./filesystem-refresh";

it("coalesces storms behind one running scan and delivers the last write only to its project", async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	const releases: (() => void)[] = [];
	let calls = 0;
	let active = 0;
	let peak = 0;
	const observer = new QueryObserver(client, {
		queryKey: ["summary", "/app"],
		queryFn: async () => {
			calls++;
			peak = Math.max(peak, ++active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active--;
			return calls;
		},
	});
	const unrelated = vi.fn(async () => "unchanged");
	const other = new QueryObserver(client, { queryKey: ["summary", "/other"], queryFn: unrelated });
	const stop = observer.subscribe(() => {});
	const stopOther = other.subscribe(() => {});
	const refresh = createFilesystemRefresh(client);
	for (let index = 0; index < 10_000; index++) refresh.project("/app");
	expect(calls).toBe(1);
	releases[0]();
	await vi.waitFor(() => expect(calls).toBe(2));
	for (let index = 0; index < 10_000; index++) refresh.project("/app");
	releases[1]();
	await vi.waitFor(() => expect(calls).toBe(3));
	releases[2]();
	await vi.waitFor(() => expect(client.isFetching()).toBe(0));
	expect(peak).toBe(1);
	expect(unrelated).toHaveBeenCalledTimes(1);
	expect(client.getQueryData(["summary", "/app"])).toBe(3);
	refresh.dispose();
	stop();
	stopOther();
	client.clear();
});

it("waits for inactive reads without spinning and cancels trailing work on disposal", async () => {
	const client = new QueryClient();
	let release = () => {};
	const read = client.fetchQuery({
		queryKey: ["preview", { project: "/app", path: "file.ts" }],
		queryFn: () =>
			new Promise<string>((resolve) => {
				release = () => resolve("latest");
			}),
	});
	const refresh = createFilesystemRefresh(client);
	refresh.project("/app");
	refresh.dispose();
	release();
	await read;
	expect(client.isFetching()).toBe(0);
	expect(client.getQueryData(["preview", { project: "/app", path: "file.ts" }])).toBe("latest");
	client.clear();
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("restoring during the first scan starts a fresh request and ignores the old response", async () => {
	const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
	const old = { repos: [], scanLimited: false, updatedAt: 1 };
	const fresh = { ...old, updatedAt: 2 };
	let finishOld = (_value: typeof old) => {};
	let finishFresh = (_value: typeof old) => {};
	vi.mocked(invoke)
		.mockReset()
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishOld = resolve;
				}),
		)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishFresh = resolve;
				}),
		);
	const observer = new QueryObserver(client, projectSummaryOptions("/app"));
	const archive = observer.subscribe(() => {});
	expect(invoke).toHaveBeenCalledTimes(1);
	archive();
	const restored = observer.subscribe(() => {});
	try {
		await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
		finishFresh(fresh);
		await vi.waitFor(() => expect(observer.getCurrentResult().data?.updatedAt).toBe(2));
		finishOld(old);
		await Promise.resolve();
		await Promise.resolve();
		expect(observer.getCurrentResult().data?.updatedAt).toBe(2);
	} finally {
		finishOld(old);
		finishFresh(fresh);
		restored();
		client.clear();
	}
});
