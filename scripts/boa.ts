#!/usr/bin/env bun
/** Agent-friendly BOA CLI: navigation and private app-owned project management. */
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBoa } from "./mac-app";

export type ProjectRequest =
	| { command: "contexts"; request: Record<string, unknown> }
	| { command: "reader-open"; file: string; line: number; endLine: number; source: string }
	| { command: "reader-status"; requestId: string }
	| { command: "workspace"; request: Record<string, unknown> }
	| { command: "list" }
	| { command: "add"; path: string; pin: boolean }
	| { command: "pin" | "unpin"; path: string };
type Reply = { ok: true; result: unknown } | { ok: false; error: string };
const HELP = `BOA — navigation et projets locaux

boa open <file> [--line 42] [--end-line 50] [--source Codex|Claude|Cursor|CLI] [--wait] [--json] [--wait-ms 10000] [--dry-run]
boa contexts list --project <root> [--json]
boa contexts get <id> --project <root> [--json]
boa contexts save [id] --project <root> --file <view.json> [--revision N] [--json] [--dry-run]
boa contexts update <id> --project <root> --file <patch.json> --revision N [--json] [--dry-run]
boa contexts reorder <id> --project <root> --steps <id,id,...> --revision N [--json] [--dry-run]
boa contexts remove <id> --project <root> [--json] [--dry-run]
boa contexts open <id> --project <root> [--step <id>] [--passage <id>] [--wait] [--json] [--wait-ms 10000]
boa receipt <request-id> [--json]

Context JSON: id, project, title, description, kind (walkthrough|findings), steps.
Step: id, title, description, optional group, passages. Passage: id, path (relative),
startLine, endLine, optional label, role, symbol and text anchor.
Save creates/replaces the complete view; update merges only supplied top-level fields.
--revision guards against concurrent changes. Reorder includes every step exactly once.
--wait or --json on open waits for the reader, not merely the request transport.
Exit 0: displayed (or queued without --wait), 1: error, 2: not confirmed displayed.
Receipts expire on app restart; query immediately. --wait-ms: 100..15000 ms.
boa spaces list [--json]
boa spaces save <id> --name <nom> [--root <dossier>] [--file <fichier>] [--json] [--dry-run]
boa spaces remove <id> [--json] [--dry-run]
boa files configure <dossier> [--include <chemin-relatif>] [--pin <chemin-relatif>] [--sort name|name-desc|added|added-asc|modified|modified-asc|created|created-asc|type|type-desc|size|size-asc] [--all] [--json] [--dry-run]
boa files preferences <dossier> [--json]
boa projects list [--json]
boa projects add <dossier> [--pin] [--json] [--dry-run]
boa projects pin|unpin <dossier> [--json] [--dry-run]
boa projects favorite|unfavorite <dossier> [--json] [--dry-run]

Raccourcis : boa add|pin|unpin|favorite|unfavorite <dossier>.
Favori et épinglé désignent la même préférence. Le CLI ouvre BOA si nécessaire.
Les dossiers sont ajoutés explicitement ; aucune découverte automatique.
--json renvoie {ok,result} ou {ok:false,error} ; une erreur retourne un code non nul.`;

export function parseProjects(args: string[]): ProjectRequest {
	const action = args[0];
	const options = new Set(["--json", "--dry-run", ...(action === "add" ? ["--pin"] : [])]);
	const rest = args.slice(1);
	for (const option of rest.filter((value) => value.startsWith("--"))) {
		if (!options.has(option)) throw new Error(`Option inconnue : ${option}`);
	}
	const positional = rest.filter((value) => !value.startsWith("--"));
	if (action === "list" && positional.length === 0) return { command: "list" };
	if (positional.length !== 1) throw new Error("Un seul chemin de dossier est attendu.");
	const path = resolve(positional[0]);
	if (action === "add") return { command: "add", path, pin: rest.includes("--pin") };
	if (["pin", "favorite", "unpin", "unfavorite"].includes(action))
		return { command: action === "pin" || action === "favorite" ? "pin" : "unpin", path };
	throw new Error("Commande attendue : projects list|add|pin|unpin|favorite|unfavorite");
}

function relativeItem(value: string): string {
	const parts = value.split("/");
	if (value.startsWith("/") || value.includes("\0") || parts.some((p) => p === ".." || p === "."))
		throw new Error("Invalid relative item path");
	const result = parts.filter(Boolean).join("/");
	if (!result) throw new Error("Empty relative item path");
	return result;
}
export function parseWorkspace(args: string[]): ProjectRequest {
	const [group, action, ...rest] = args;
	const positional: string[] = [];
	const values: Record<string, string[]> = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (["--json", "--dry-run", "--all"].includes(token)) continue;
		if (token.startsWith("--")) {
			if (
				!["--name", "--root", "--file", "--include", "--pin", "--sort"].includes(token) ||
				!rest[i + 1] ||
				rest[i + 1].startsWith("--")
			)
				throw new Error(`Invalid option: ${token}`);
			(values[token] ??= []).push(rest[++i]);
		} else positional.push(token);
	}
	const permitted =
		group === "spaces" && action === "save"
			? ["--name", "--root", "--file"]
			: group === "files" && action === "configure"
				? ["--include", "--pin", "--sort"]
				: [];
	if (
		Object.keys(values).some((k) => !permitted.includes(k)) ||
		(rest.includes("--all") && !(group === "files" && action === "configure")) ||
		(values["--sort"]?.length ?? 0) > 1
	)
		throw new Error("Invalid options for this command");
	let request: Record<string, unknown>;
	if (group === "spaces" && action === "list" && !positional.length) request = { action: "list" };
	else if (group === "spaces" && action === "remove" && positional.length === 1)
		request = { action: "remove-space", id: positional[0] };
	else if (
		group === "spaces" &&
		action === "save" &&
		positional.length === 1 &&
		values["--name"]?.length === 1 &&
		(values["--root"]?.length || values["--file"]?.length)
	)
		request = {
			action: "save-space",
			id: positional[0],
			name: values["--name"][0],
			roots: (values["--root"] ?? []).map((p) => resolve(p)),
			...(values["--file"] ? { files: values["--file"].map((p) => resolve(p)) } : {}),
		};
	else if (group === "files" && action === "preferences" && positional.length === 1)
		request = { action: "preferences", root: resolve(positional[0]) };
	else if (group === "files" && action === "configure" && positional.length === 1) {
		const sort = values["--sort"]?.[0] ?? "name";
		if (
			![
				"name",
				"name-desc",
				"added",
				"added-asc",
				"modified",
				"modified-asc",
				"created",
				"created-asc",
				"type",
				"type-desc",
				"size",
				"size-asc",
			].includes(sort)
		)
			throw new Error("Invalid sort");
		request = {
			action: "set-preferences",
			root: resolve(positional[0]),
			preferences: {
				filtered: !rest.includes("--all"),
				included: (values["--include"] ?? []).map(relativeItem),
				pins: (values["--pin"] ?? []).map(relativeItem),
				sort,
			},
		};
	} else throw new Error("Invalid spaces/files command; see boa --help");
	return { command: "workspace", request };
}

/** Context mutations are sent to BOA, never written to its data files by the CLI. */
export function parseContexts(args: string[]): ProjectRequest {
	const [action, ...rest] = args;
	const values: Record<string, string> = {};
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (["--json", "--dry-run", "--wait"].includes(token)) continue;
		if (token.startsWith("--")) {
			if (
				!["--project", "--file", "--revision", "--steps", "--step", "--passage", "--wait-ms"].includes(
					token,
				) ||
				!rest[i + 1] ||
				rest[i + 1].startsWith("--") ||
				values[token] !== undefined
			)
				throw new Error(`Invalid option: ${token}`);
			values[token] = rest[++i];
		} else positional.push(token);
	}
	const allowed: Record<string, string[]> = {
		list: ["--project"],
		get: ["--project"],
		save: ["--project", "--file", "--revision"],
		update: ["--project", "--file", "--revision"],
		reorder: ["--project", "--steps", "--revision"],
		remove: ["--project"],
		open: ["--project", "--step", "--passage", "--wait-ms"],
		status: [],
	};
	if (
		!allowed[action] ||
		Object.keys(values).some((k) => !allowed[action].includes(k)) ||
		(rest.includes("--wait") && action !== "open")
	)
		throw new Error("Invalid context command options");
	if (action === "status" && positional.length === 1)
		return { command: "reader-status", requestId: positional[0] };
	if (!values["--project"]) throw new Error("--project is required");
	const project = resolve(values["--project"]);
	const revision = values["--revision"] === undefined ? undefined : Number(values["--revision"]);
	if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0))
		throw new Error("Invalid revision");
	let request: Record<string, unknown>;
	if (action === "list" && positional.length === 0) request = { action, project };
	else if (action === "save" && positional.length <= 1 && values["--file"]) {
		const path = resolve(values["--file"]);
		if (statSync(path).size > 48 * 1024) throw new Error("Context input exceeds 48 KiB");
		const view = JSON.parse(readFileSync(path, "utf8"));
		if (!view || typeof view !== "object" || Array.isArray(view))
			throw new Error("Context view must be a JSON object");
		request = {
			action,
			view: { ...view, project, ...(positional[0] ? { id: positional[0] } : {}) },
			expectedRevision: revision,
		};
	} else if (positional.length === 1) {
		const id = positional[0];
		if (action === "get" || action === "remove") request = { action, project, id };
		else if (action === "open")
			request = { action, project, id, stepId: values["--step"], passageId: values["--passage"] };
		else if (action === "update" && values["--file"] && revision !== undefined) {
			const path = resolve(values["--file"]);
			if (statSync(path).size > 48 * 1024) throw new Error("Context patch exceeds 48 KiB");
			request = {
				action,
				project,
				id,
				patch: JSON.parse(readFileSync(path, "utf8")),
				expectedRevision: revision,
			};
		} else if (action === "reorder" && values["--steps"] && revision !== undefined)
			request = { action, project, id, stepIds: values["--steps"].split(","), expectedRevision: revision };
		else throw new Error("Invalid context command; see boa --help");
	} else throw new Error("Invalid context command; see boa --help");
	return { command: "contexts", request };
}

function waitDuration(args: string[]): number {
	const index = args.indexOf("--wait-ms");
	const value = index < 0 ? 10000 : Number(args[index + 1]);
	if (!Number.isSafeInteger(value) || value < 100 || value > 15000)
		throw new Error("--wait-ms must be between 100 and 15000");
	return value;
}
async function waitForReader(reply: Reply, args: string[]): Promise<Reply> {
	if (!reply.ok || !(args.includes("--wait") || args.includes("--json"))) return reply;
	const deadline = Date.now() + waitDuration(args);
	let current = reply;
	while (
		current.ok &&
		(current.result as { status?: string }).status === "pending" &&
		Date.now() < deadline
	) {
		await new Promise((done) => setTimeout(done, 100));
		current = await sendRequest({
			command: "reader-status",
			requestId: (current.result as { requestId: string }).requestId,
		});
	}
	return current;
}
function readerExit(reply: Reply, args: string[]): number {
	if (!reply.ok) return 1;
	return args.includes("--wait") || args.includes("--json")
		? (reply.result as { status?: string }).status === "displayed"
			? 0
			: 2
		: 0;
}

export function cliSocketPath(): string {
	if (!process.geteuid) throw new Error("Le CLI BOA requiert macOS ou Unix.");
	return `/tmp/boa-cli-${process.geteuid()}/rpc.sock`;
}

/** Uses the app's shared state, never edits projects.json directly. */
export async function sendRequest(request: ProjectRequest, socketPath = cliSocketPath()): Promise<Reply> {
	const owner = process.geteuid?.();
	const directory = lstatSync(dirname(socketPath));
	const socket = lstatSync(socketPath);
	if (!directory.isDirectory() || directory.uid !== owner || (directory.mode & 0o077) !== 0)
		throw new Error("Dossier RPC non privé ou propriétaire incorrect.");
	if (!socket.isSocket() || socket.uid !== owner || (socket.mode & 0o077) !== 0)
		throw new Error("Socket RPC non privé ou propriétaire incorrect.");
	return new Promise((done, fail) => {
		const client = createConnection(socketPath);
		const chunks: Buffer[] = [];
		let length = 0;
		let settled = false;
		const finish = (error?: Error, result?: Reply) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			client.destroy();
			if (error) fail(error);
			else done(result as Reply);
		};
		const deadline = setTimeout(() => finish(new Error("Délai RPC BOA dépassé.")), 4500);
		client.on("error", (error) => finish(error));
		client.on("connect", () => {
			const encoded = `${JSON.stringify(request)}\n`;
			if (Buffer.byteLength(encoded) > 65536) return finish(new Error("BOA request exceeds 64 KiB"));
			client.write(encoded);
		});
		client.on("end", () => finish(new Error("Réponse RPC BOA incomplète.")));
		client.on("data", (chunk: Buffer) => {
			length += chunk.length;
			if (length > 2 * 1024 * 1024) return finish(new Error("Réponse RPC BOA trop grande."));
			chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			const newline = bytes.indexOf(10);
			if (newline < 0) return;
			try {
				const reply = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
				if (typeof reply.ok !== "boolean" || (!reply.ok && typeof reply.error !== "string"))
					throw new Error("Réponse RPC BOA invalide.");
				finish(undefined, reply);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

async function connectApp(request: ProjectRequest): Promise<Reply> {
	try {
		return await sendRequest(request);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
	}
	launchBoa();
	for (let attempt = 0; attempt < 50; attempt++) {
		await new Promise((done) => setTimeout(done, 200));
		try {
			return await sendRequest(request);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
		}
	}
	throw new Error("BOA ne répond pas au CLI après 10 secondes. Vérifiez sa version et son démarrage.");
}

export function openUrl(args: string[]): string {
	if (!args[0] || args[0].startsWith("--")) throw new Error("Usage : boa open <fichier> --line <ligne>");
	const file = resolve(args[0]);
	if (!statSync(file).isFile()) throw new Error("Le chemin doit désigner un fichier.");
	let line = 1;
	let endLine: number | undefined;
	let source = "CLI";
	for (let index = 1; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--dry-run") continue;
		const value = args[++index];
		if (!value) throw new Error(`Valeur manquante : ${argument}`);
		if (argument === "--line") line = Number(value);
		else if (argument === "--end-line") endLine = Number(value);
		else if (argument === "--source") source = value;
		else throw new Error(`Option inconnue : ${argument}`);
	}
	if (
		!Number.isSafeInteger(line) ||
		line < 1 ||
		line > 1_000_000 ||
		(endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line || endLine > 1_000_000))
	)
		throw new Error("Plage de lignes invalide");
	if (!["Codex", "Claude", "Cursor", "CLI"].includes(source))
		throw new Error("Source attendue : Codex, Claude, Cursor ou CLI");
	const url = new URL("boa://open");
	url.search = new URLSearchParams({
		file,
		line: String(line),
		endLine: String(endLine ?? line),
		source,
		request: crypto.randomUUID(),
	}).toString();
	return url.href;
}

export async function main(args: string[]): Promise<number> {
	const json = args.includes("--json");
	try {
		if (args.length === 0 || args[0] === "--help" || args[0] === "help") {
			console.log(HELP);
			return 0;
		}
		if (args[0] === "open") {
			const transportOptions = ["--json", "--wait"];
			const clean = args
				.slice(1)
				.filter(
					(v, i, all) => !transportOptions.includes(v) && v !== "--wait-ms" && all[i - 1] !== "--wait-ms",
				);
			const url = openUrl(clean);
			if (args.includes("--wait") || json) {
				waitDuration(args);
				const parsed = new URL(url);
				const request: ProjectRequest = {
					command: "reader-open",
					file: parsed.searchParams.get("file") as string,
					line: Number(parsed.searchParams.get("line")),
					endLine: Number(parsed.searchParams.get("endLine")),
					source: parsed.searchParams.get("source") as string,
				};
				const initial: Reply = args.includes("--dry-run")
					? { ok: true, result: request }
					: await connectApp(request);
				const reply = args.includes("--dry-run") ? initial : await waitForReader(initial, args);
				console.log(JSON.stringify(reply));
				return args.includes("--dry-run") ? (reply.ok ? 0 : 1) : readerExit(reply, args);
			}
			if (args.includes("--dry-run")) console.log(url);
			else {
				const result = spawnSync("/usr/bin/open", [url], { encoding: "utf8" });
				if (result.error || result.status !== 0)
					throw new Error(result.stderr || "Installez et ouvrez BOA.app.");
				console.log(`Demande envoyée à BOA : ${resolve(args[1])}`);
			}
			return 0;
		}
		const request =
			args[0] === "contexts"
				? parseContexts(args.slice(1))
				: args[0] === "receipt"
					? (() => {
							const rest = args.slice(1).filter((v) => v !== "--json");
							if (rest.length !== 1 || rest[0].startsWith("--"))
								throw new Error("Usage: boa receipt <request-id> [--json]");
							return { command: "reader-status", requestId: rest[0] } as ProjectRequest;
						})()
					: ["spaces", "files"].includes(args[0])
						? parseWorkspace(args)
						: parseProjects(args[0] === "projects" ? args.slice(1) : args);
		const opening = request.command === "contexts" && request.request.action === "open";
		if (opening) waitDuration(args);
		let reply: Reply = args.includes("--dry-run") ? { ok: true, result: request } : await connectApp(request);
		if (opening && !args.includes("--dry-run")) reply = await waitForReader(reply, args);
		if (json || args.includes("--dry-run")) console.log(JSON.stringify(reply));
		else if (!reply.ok) console.error(reply.error);
		else if (request.command === "list") {
			for (const item of reply.result as { pinned: boolean; path: string }[])
				console.log(`${item.pinned ? "★" : "·"} ${item.path}`);
		} else console.log(JSON.stringify(reply.result, null, 2));
		return opening && !args.includes("--dry-run") ? readerExit(reply, args) : reply.ok ? 0 : 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) console.log(JSON.stringify({ ok: false, error: message }));
		else console.error(message);
		return 1;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
	process.exitCode = await main(process.argv.slice(2));
