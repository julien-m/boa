#!/usr/bin/env bun
/** Agent-friendly BOA CLI: navigation and private app-owned project management. */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ProjectRequest =
	| { command: "list" }
	| { command: "add"; path: string; pin: boolean }
	| { command: "pin" | "unpin"; path: string };
type Reply = { ok: true; result: unknown } | { ok: false; error: string };
const HELP = `BOA — navigation et projets locaux

boa open <fichier> [--line 42] [--end-line 50] [--source Codex|Claude|Cursor|CLI] [--dry-run]
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
		client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
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
	const launch = spawnSync("/usr/bin/open", ["-a", "BOA"], { encoding: "utf8" });
	if (launch.error || launch.status !== 0)
		throw new Error("Installez BOA.app dans Applications et ouvrez-la une première fois.");
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
			const url = openUrl(args.slice(1));
			if (args.includes("--dry-run")) console.log(url);
			else {
				const result = spawnSync("/usr/bin/open", [url], { encoding: "utf8" });
				if (result.error || result.status !== 0)
					throw new Error(result.stderr || "Installez et ouvrez BOA.app.");
				console.log(`Demande envoyée à BOA : ${resolve(args[1])}`);
			}
			return 0;
		}
		const request = parseProjects(args[0] === "projects" ? args.slice(1) : args);
		const reply: Reply = args.includes("--dry-run")
			? { ok: true, result: request }
			: await connectApp(request);
		if (json || args.includes("--dry-run")) console.log(JSON.stringify(reply));
		else if (!reply.ok) console.error(reply.error);
		else if (request.command === "list") {
			for (const item of reply.result as { pinned: boolean; path: string }[])
				console.log(`${item.pinned ? "★" : "·"} ${item.path}`);
		} else console.log(JSON.stringify(reply.result, null, 2));
		return reply.ok ? 0 : 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) console.log(JSON.stringify({ ok: false, error: message }));
		else console.error(message);
		return 1;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
	process.exitCode = await main(process.argv.slice(2));
