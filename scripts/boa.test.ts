import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openUrl, parseProjects, sendRequest } from "./boa";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "boa-cli-test-"));
	roots.push(root);
	chmodSync(root, 0o700);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BOA project CLI", () => {
	it("parses all explicit commands, aliases and strict options", () => {
		expect(parseProjects(["list", "--json"])).toEqual({ command: "list" });
		expect(parseProjects(["add", "./example", "--pin"])).toEqual({
			command: "add",
			path: resolve("example"),
			pin: true,
		});
		expect(parseProjects(["favorite", "./example"])).toMatchObject({ command: "pin" });
		expect(parseProjects(["unfavorite", "./example"])).toMatchObject({ command: "unpin" });
		expect(() => parseProjects(["add", "example", "--shell"])).toThrow("Option inconnue");
		expect(() => parseProjects(["pin", "a", "b"])).toThrow("Un seul chemin");
	});

	it("runs the executable via a symlink and emits JSON errors with nonzero exit", () => {
		const link = join(fixture(), "boa");
		symlinkSync(resolve("scripts/boa.ts"), link);
		const dry = spawnSync("bun", [link, "projects", "add", "/tmp", "--pin", "--dry-run", "--json"], {
			encoding: "utf8",
		});
		expect(dry.status).toBe(0);
		expect(JSON.parse(dry.stdout)).toMatchObject({ ok: true, result: { command: "add", pin: true } });
		const bad = spawnSync("bun", [link, "projects", "add", "--json"], { encoding: "utf8" });
		expect(bad.status).toBe(1);
		expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: expect.any(String) });
	});

	it("preserves exact file navigation and validates ranges", () => {
		const path = join(fixture(), "file # é.ts");
		writeFileSync(path, "hello");
		const url = new URL(openUrl([path, "--line", "3", "--end-line", "8", "--source", "Codex"]));
		expect(url.searchParams.get("file")).toBe(path);
		expect(url.searchParams.get("endLine")).toBe("8");
		expect(() => openUrl([path, "--line", "4", "--end-line", "2"])).toThrow("Plage");
	});

	it("uses bounded newline JSON on a real private Unix socket", async () => {
		const socket = join(fixture(), "rpc.sock");
		let received = "";
		const server = createServer((client) => {
			client.on("data", (data) => {
				received += data.toString();
				client.end(`${JSON.stringify({ ok: true, result: [{ name: "fixture", pinned: false }] })}\n`);
			});
		});
		await new Promise<void>((done) => server.listen(socket, done));
		chmodSync(socket, 0o600);
		try {
			const reply = await sendRequest({ command: "list" }, socket);
			expect(reply).toMatchObject({ ok: true, result: [{ name: "fixture" }] });
			expect(received).toBe('{"command":"list"}\n');
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});

	it("refuses a socket symlink without sending data", async () => {
		const root = fixture();
		const socket = join(root, "link.sock");
		writeFileSync(join(root, "target"), "");
		symlinkSync(join(root, "target"), socket);
		await expect(sendRequest({ command: "list" }, socket)).rejects.toThrow("Socket RPC non privé");
	});

	it("rejects malformed server replies", async () => {
		const socket = join(fixture(), "rpc.sock");
		const server = createServer((client) => client.once("data", () => client.end('{"ok":"yes"}\n')));
		await new Promise<void>((done) => server.listen(socket, done));
		chmodSync(socket, 0o600);
		try {
			await expect(sendRequest({ command: "list" }, socket)).rejects.toThrow("invalide");
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});
});
