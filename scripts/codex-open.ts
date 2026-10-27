#!/usr/bin/env bun
/** Bridge the desktop custom-file-handler JSON contract to BOA's acknowledged CLI. */
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { main, openUrl } from "./boa";
import { launchBoa } from "./mac-app";

export function codexOpenArgs(input: string): string[] {
	const payload = JSON.parse(input);
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new Error("Expected a desktop file-handler JSON object");
	if (typeof payload.path !== "string" || !isAbsolute(payload.path) || payload.path.includes("\0"))
		throw new Error("Expected an absolute local file path");
	if (payload.hostConfig != null || payload.remotePath != null || payload.remoteWorkspaceRoot != null)
		throw new Error("Remote files are not supported by the BOA handler");
	const location = payload.location;
	if (
		location != null &&
		(typeof location !== "object" ||
			Array.isArray(location) ||
			!Number.isSafeInteger(location.line) ||
			location.line < 1 ||
			location.line > 1_000_000)
	)
		throw new Error("Expected a 1-based line between 1 and 1000000");
	return ["open", payload.path, "--line", String(location?.line ?? 1), "--source", "Codex"];
}

const nativeTransport = {
	launch: launchBoa,
	navigate: main,
};

export async function codexOpen(args: string[], transport = nativeTransport): Promise<number> {
	try {
		if (args.length < 1 || args.length > 2 || (args.length === 2 && args[1] !== "--dry-run"))
			throw new Error("Usage: bun scripts/codex-open.ts '<handler-json>' [--dry-run]");
		const command = codexOpenArgs(args[0]);
		if (!statSync(command[1]).isFile()) throw new Error("Expected an existing local file");
		if (args[1] === "--dry-run") {
			console.log(openUrl(command.slice(1)));
			return 0;
		}
		// Launch only the installed bundle; send the file once through the private socket.
		transport.launch();
		return await transport.navigate([...command, "--wait", "--json"]);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await codexOpen(process.argv.slice(2));
}
