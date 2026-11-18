/**
 * `boa sessions …` and `boa actions …`: parsing, bilingual help and error messages.
 * Every command becomes one `{command: "sessions", request}` RPC handled by the app's
 * shared sessions service (the same one the UI uses).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Lang = "fr" | "en";
export type SessionsRequest = { command: "sessions"; request: Record<string, unknown> };
type Options = { flags: Set<string>; values: Map<string, string>; positional: string[] };

/** A Claude send waits for its per-message acknowledgement (cold start ≈42 s, bridge cap 120 s). */
export const SESSIONS_TIMEOUT_MS = 140_000;

export function cliLanguage(args: string[], env = process.env): Lang {
	const index = args.indexOf("--lang");
	const requested = index >= 0 ? args[index + 1] : (env.BOA_LANG ?? env.LANG ?? "");
	return requested.toLowerCase().startsWith("en") ? "en" : "fr";
}

const HELP: Record<Lang, string> = {
	fr: `BOA — sessions Codex et Claude Code

boa sessions settings
boa sessions discovery on|off [--providers codex,claude] [--revision N]
boa sessions autopin on|off [--revision N]
boa sessions list [--all] [--search <texte>] [--provider codex|claude] [--project <dossier>] [--state <état>]
boa sessions show|pin|unpin|resume|open <fournisseur:id>
boa sessions conversation <fournisseur:id> [--limit 1..200]
boa sessions rename <fournisseur:id> --title <titre>
boa sessions send <fournisseur:id> (--text <message> | --file <fichier>)
boa sessions new --provider codex|claude --project <dossier> (--text <message> | --file <fichier>) [--title <titre>]
boa sessions branch <fournisseur:id> [--switch <branche>]
boa sessions permission <claude:id> --request <id> allow|deny
boa sessions daemon start

boa actions list [--project <dossier>]
boa actions add --id <id> --label <libellé> (--template <texte> | --template-file <fichier>)
                [--mode prepare|send] [--providers codex,claude] [--disabled] [--project <dossier>]
boa actions update <id> [--label …] [--template … | --template-file …] [--mode …] [--providers …] [--project <dossier>]
boa actions enable|disable|remove <id> [--project <dossier>]
boa actions reorder --ids <id,id,…> [--project <dossier>]
boa actions reset --project <dossier> [--id <id>]
boa actions render <id> --session <fournisseur:id> [--file <chemin>] [--selection <texte>]

Variables de modèle : {projet} {branche} {fichier} {sélection} (ou {project} {branch} {file} {selection}).
Une session se désigne par fournisseur:id, par exemple codex:01a1… ou claude:8b34….
La découverte des historiques locaux est désactivée tant que « discovery on » n'est pas choisi ;
seuls les dossiers des projets enregistrés sont interrogés.
Envoyer transmet immédiatement ; le réglage file/steer du fournisseur décide du traitement.
--revision N refuse la modification si la configuration a changé entre-temps.
--json renvoie {ok,result} ou {ok:false,code,error}. --lang fr|en choisit la langue.`,
	en: `BOA — Codex and Claude Code sessions

boa sessions settings
boa sessions discovery on|off [--providers codex,claude] [--revision N]
boa sessions autopin on|off [--revision N]
boa sessions list [--all] [--search <text>] [--provider codex|claude] [--project <folder>] [--state <state>]
boa sessions show|pin|unpin|resume|open <provider:id>
boa sessions conversation <provider:id> [--limit 1..200]
boa sessions rename <provider:id> --title <title>
boa sessions send <provider:id> (--text <message> | --file <file>)
boa sessions new --provider codex|claude --project <folder> (--text <message> | --file <file>) [--title <title>]
boa sessions branch <provider:id> [--switch <branch>]
boa sessions permission <claude:id> --request <id> allow|deny
boa sessions daemon start

boa actions list [--project <folder>]
boa actions add --id <id> --label <label> (--template <text> | --template-file <file>)
                [--mode prepare|send] [--providers codex,claude] [--disabled] [--project <folder>]
boa actions update <id> [--label …] [--template … | --template-file …] [--mode …] [--providers …] [--project <folder>]
boa actions enable|disable|remove <id> [--project <folder>]
boa actions reorder --ids <id,id,…> [--project <folder>]
boa actions reset --project <folder> [--id <id>]
boa actions render <id> --session <provider:id> [--file <path>] [--selection <text>]

Template variables: {project} {branch} {file} {selection} (or {projet} {branche} {fichier} {sélection}).
A session is addressed as provider:id, for example codex:01a1… or claude:8b34….
Local history discovery stays off until "discovery on" is chosen; only registered project
folders are queried.
Send transmits immediately; the provider's own queue/steer setting decides how it is handled.
--revision N refuses the change if the configuration changed meanwhile.
--json prints {ok,result} or {ok:false,code,error}. --lang fr|en selects the language.`,
};

export function sessionsHelp(lang: Lang): string {
	return HELP[lang];
}

const MESSAGES: Record<string, Record<Lang, string>> = {
	discovery_disabled: {
		fr: "La découverte des sessions est désactivée : lancez « boa sessions discovery on ».",
		en: 'Session discovery is off: run "boa sessions discovery on".',
	},
	codex_daemon_not_running: {
		fr: "Le démon Codex partagé n'est pas démarré : « boa sessions daemon start » le démarre explicitement.",
		en: 'The shared Codex daemon is not running: "boa sessions daemon start" starts it explicitly.',
	},
	codex_not_loaded: {
		fr: "Session Codex non chargée dans le démon partagé : reprenez-la d'abord (« boa sessions resume »).",
		en: 'Codex session not loaded in the shared daemon: resume it first ("boa sessions resume").',
	},
	claude_session_owned_elsewhere: {
		fr: "Un processus Claude Code actif détient cette session ; BOA ne crée pas de second propriétaire.",
		en: "A live Claude Code process holds this session; BOA does not create a second owner.",
	},
	result_unknown: {
		fr: "Résultat inconnu : le message a pu être reçu. Vérifiez la conversation avant de renvoyer.",
		en: "Unknown result: the message may have been received. Check the conversation before resending.",
	},
	revision_conflict: {
		fr: "La configuration a changé entre-temps ; relisez-la puis réessayez.",
		en: "The configuration changed meanwhile; reload it and retry.",
	},
	project_not_registered: {
		fr: "Ce dossier n'est pas un projet enregistré dans BOA.",
		en: "This folder is not a project registered in BOA.",
	},
	worktree_shared: {
		fr: "Une autre session active travaille dans ce working tree : changement de branche refusé.",
		en: "Another live session works in this working tree: branch change refused.",
	},
	missing_variable: {
		fr: "Valeur manquante pour une variable du modèle",
		en: "Missing value for a template variable",
	},
	session_not_found: { fr: "Session introuvable.", en: "Session not found." },
	busy: {
		fr: "BOA traite déjà trop de demandes de sessions ; réessayez.",
		en: "BOA is already handling too many session requests; retry.",
	},
};

/** Localized message for a typed error code, keeping the code visible for scripts. */
export function describeError(code: string | undefined, fallback: string, lang: Lang): string {
	const text = code ? MESSAGES[code]?.[lang] : undefined;
	if (!text) return code ? `${code}: ${fallback}` : fallback;
	return code === "missing_variable" ? `${text} (${fallback})` : `${text} [${code}]`;
}

function options(args: string[], allowedFlags: string[], allowedValues: string[]): Options {
	const flags = new Set<string>();
	const values = new Map<string, string>();
	const positional: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (["--json", "--dry-run"].includes(argument)) continue;
		if (argument === "--lang") {
			index++;
			continue;
		}
		if (!argument.startsWith("--")) {
			positional.push(argument);
			continue;
		}
		if (allowedFlags.includes(argument)) {
			flags.add(argument);
			continue;
		}
		if (!allowedValues.includes(argument)) throw new Error(`Option inconnue / unknown option: ${argument}`);
		const value = args[++index];
		if (value === undefined) throw new Error(`Valeur manquante / missing value: ${argument}`);
		values.set(argument, value);
	}
	return { flags, values, positional };
}

export function parseSessionKey(value: string | undefined): { provider: string; id: string } {
	const match = value?.match(/^(codex|claude):([A-Za-z0-9_-]{1,128})$/);
	if (!match) throw new Error("Session attendue / expected session: <codex|claude>:<id>");
	return { provider: match[1], id: match[2] };
}

function revision(opts: Options): number | undefined {
	const raw = opts.values.get("--revision");
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("--revision: entier ≥ 0 / integer ≥ 0");
	return value;
}

function providers(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	const list = raw.split(",").filter(Boolean);
	if (list.length === 0 || list.some((p) => p !== "codex" && p !== "claude"))
		throw new Error("--providers: codex,claude");
	return list;
}

function onOff(value: string | undefined): boolean {
	if (value === "on") return true;
	if (value === "off") return false;
	throw new Error("on|off");
}

function textInput(opts: Options, inline: string, file: string): string | undefined {
	if (opts.values.has(inline) && opts.values.has(file)) throw new Error(`${inline} | ${file}`);
	const path = opts.values.get(file);
	return path !== undefined ? readFileSync(resolve(path), "utf8") : opts.values.get(inline);
}

function required(value: string | undefined, name: string): string {
	if (value === undefined || value.trim() === "") throw new Error(`${name} requis / required`);
	return value;
}

const wrap = (request: Record<string, unknown>): SessionsRequest => ({ command: "sessions", request });

export function parseSessions(args: string[]): SessionsRequest {
	const [action, ...rest] = args;
	const opts = options(
		rest,
		["--all"],
		[
			"--providers",
			"--revision",
			"--search",
			"--provider",
			"--project",
			"--state",
			"--limit",
			"--title",
			"--text",
			"--file",
			"--switch",
			"--request",
		],
	);
	const session = () => parseSessionKey(opts.positional[0]);
	switch (action) {
		case "settings":
			return wrap({ action: "settings" });
		case "discovery":
			return wrap({
				action: "setDiscovery",
				enabled: onOff(opts.positional[0]),
				providers: (() => {
					const list = providers(opts.values.get("--providers"));
					return list ? { codex: list.includes("codex"), claude: list.includes("claude") } : undefined;
				})(),
				revision: revision(opts),
			});
		case "autopin":
			return wrap({ action: "setAutoPin", enabled: onOff(opts.positional[0]), revision: revision(opts) });
		case "list": {
			const project = opts.values.get("--project");
			return wrap({
				action: "list",
				query: {
					scope: opts.flags.has("--all") ? "all" : "pinned",
					search: opts.values.get("--search"),
					provider: opts.values.get("--provider"),
					project: project ? resolve(project) : undefined,
					state: opts.values.get("--state"),
				},
			});
		}
		case "show":
		case "pin":
		case "unpin":
		case "resume":
			return wrap({ action: action, session: session() });
		case "open":
			return wrap({ action: "openInApp", session: session() });
		case "conversation": {
			const limit = Number(opts.values.get("--limit") ?? 60);
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit 1..200");
			return wrap({ action: "conversation", session: session(), limit });
		}
		case "rename":
			return wrap({
				action: "rename",
				session: session(),
				title: required(opts.values.get("--title"), "--title"),
			});
		case "send":
			return wrap({
				action: "send",
				session: session(),
				text: required(textInput(opts, "--text", "--file"), "--text"),
			});
		case "new":
			return wrap({
				action: "create",
				provider: required(opts.values.get("--provider"), "--provider"),
				project: resolve(required(opts.values.get("--project"), "--project")),
				text: required(textInput(opts, "--text", "--file"), "--text"),
				title: opts.values.get("--title"),
			});
		case "branch": {
			const target = opts.values.get("--switch");
			return target
				? wrap({ action: "requestBranch", session: session(), target })
				: wrap({ action: "branch", session: session() });
		}
		case "permission": {
			const decision = opts.positional[1];
			if (decision !== "allow" && decision !== "deny") throw new Error("allow|deny");
			return wrap({
				action: "permission",
				session: session(),
				requestId: required(opts.values.get("--request"), "--request"),
				allow: decision === "allow",
			});
		}
		case "daemon":
			if (opts.positional[0] !== "start") throw new Error("boa sessions daemon start");
			return wrap({ action: "startCodexDaemon" });
		default:
			throw new Error("boa sessions --help");
	}
}

export function parseActions(args: string[]): SessionsRequest {
	const [action, ...rest] = args;
	const opts = options(
		rest,
		["--disabled"],
		[
			"--project",
			"--id",
			"--label",
			"--template",
			"--template-file",
			"--mode",
			"--providers",
			"--ids",
			"--session",
			"--file",
			"--selection",
			"--revision",
		],
	);
	const projectValue = opts.values.get("--project");
	const project = projectValue ? resolve(projectValue) : undefined;
	const id = () => required(opts.positional[0], "<id>");
	const mode = opts.values.get("--mode");
	if (mode !== undefined && mode !== "prepare" && mode !== "send") throw new Error("--mode prepare|send");
	const change = (body: Record<string, unknown>) =>
		wrap({ action: "changeActions", revision: revision(opts), change: body });
	switch (action) {
		case "list":
			return wrap({ action: "actions", project });
		case "add":
			return change({
				change: "add",
				project,
				action: {
					id: required(opts.values.get("--id"), "--id"),
					label: required(opts.values.get("--label"), "--label"),
					template: required(textInput(opts, "--template", "--template-file"), "--template"),
					mode: mode ?? "prepare",
					providers: providers(opts.values.get("--providers")) ?? ["codex", "claude"],
					enabled: !opts.flags.has("--disabled"),
				},
			});
		case "update": {
			const patch = {
				label: opts.values.get("--label"),
				template: textInput(opts, "--template", "--template-file"),
				mode,
				providers: providers(opts.values.get("--providers")),
			};
			if (Object.values(patch).every((value) => value === undefined))
				throw new Error("update: --label|--template|--mode|--providers");
			return change({ change: "update", project, id: id(), patch });
		}
		case "enable":
		case "disable":
			return change({ change: "update", project, id: id(), patch: { enabled: action === "enable" } });
		case "remove":
			return change({ change: "remove", project, id: id() });
		case "reorder":
			return change({
				change: "reorder",
				project,
				ids: required(opts.values.get("--ids"), "--ids").split(",").filter(Boolean),
			});
		case "reset":
			return change({
				change: "reset",
				project: required(project, "--project"),
				id: opts.values.get("--id"),
			});
		case "render":
			return wrap({
				action: "renderAction",
				session: parseSessionKey(opts.values.get("--session")),
				actionId: id(),
				file: opts.values.get("--file"),
				selection: opts.values.get("--selection"),
			});
		default:
			throw new Error("boa actions --help");
	}
}

/** Human-readable summary of a successful result; scripts use --json. */
export function formatResult(request: SessionsRequest, result: unknown, lang: Lang): string {
	const action = request.request.action;
	if (action === "list" && result && typeof result === "object") {
		const listing = result as {
			discoveryEnabled: boolean;
			sessions: Array<{
				key: { provider: string; id: string };
				title: string;
				state: string;
				project?: string;
			}>;
			issues: Array<{ provider: string; code: string }>;
		};
		if (!listing.discoveryEnabled) return describeError("discovery_disabled", "", lang);
		const lines = listing.sessions.map(
			(s) => `${s.key.provider}:${s.key.id}\t${s.state}\t${s.title}${s.project ? `\t${s.project}` : ""}`,
		);
		for (const issue of listing.issues)
			lines.push(`! ${issue.provider}: ${describeError(issue.code, "", lang)}`);
		return lines.length ? lines.join("\n") : lang === "en" ? "No session." : "Aucune session.";
	}
	if (action === "renderAction" && result && typeof result === "object")
		return (result as { text: string }).text;
	return JSON.stringify(result, null, 2);
}
