/**
 * Session cockpit UI smoke: real frontend, fictional in-memory IPC (no provider, no personal data).
 * Checks opt-in, pinned view, unpin/search, rename confirmation, dock persistence across views,
 * immediate Send receipts and action settings. Screenshots go to BOA_SMOKE_OUT (default: tmpdir).
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = process.env.BOA_SMOKE_OUT ?? resolve(tmpdir(), "boa-sessions-smoke");
mkdirSync(output, { recursive: true });
const projects = ["Cedar", "Atlas", "Nimbus"].map((name, index) => ({
	name,
	path: `/Users/example/Projects/${name.toLowerCase()}`,
	pinned: true,
	archived: false,
	index,
}));
const yes = { available: true };
const now = Date.now();
type Fake = {
	key: { provider: "codex" | "claude"; id: string };
	title: string;
	project: string;
	state: string;
	evidence: string;
	pinned: boolean;
	updatedAt: number;
	branch: string;
};
const sessions: Fake[] = [
	{
		key: { provider: "claude", id: "c1" },
		title: "Remise annuelle : vérifier l'arrondi",
		project: projects[0].path,
		state: "working",
		evidence: "boaOwned",
		pinned: true,
		updatedAt: now - 20_000,
		branch: "feature/annual-billing",
	},
	{
		key: { provider: "codex", id: "x1" },
		title: "Tests du composant PlanCard",
		project: projects[0].path,
		state: "awaitingInput",
		evidence: "codexDaemon",
		pinned: true,
		updatedAt: now - 360_000,
		branch: "test/plan-card",
	},
	{
		key: { provider: "claude", id: "c2" },
		title: "Revue du module d'export",
		project: projects[1].path,
		state: "inactive",
		evidence: "claudeNoProcess",
		pinned: true,
		updatedAt: now - 7_200_000,
		branch: "main",
	},
	{
		key: { provider: "codex", id: "x2" },
		title: "Analyse des logs de synchro",
		project: projects[2].path,
		state: "unknown",
		evidence: "codexDaemon",
		pinned: false,
		updatedAt: now - 120_000,
		branch: "main",
	},
];
let discovery = false;
let revision = 1;
let actions = [
	{
		id: "review",
		label: "Review",
		template: "Relis {projet} sur {branche}.",
		mode: "send",
		providers: ["codex", "claude"],
		enabled: true,
		origin: "global",
	},
	{
		id: "tests",
		label: "Tests",
		template: "Lance les tests sur {branche}.",
		mode: "prepare",
		providers: ["codex", "claude"],
		enabled: true,
		origin: "global",
	},
];
const sent: { id: string; text: string }[] = [];
const createdRequests: { provider: string; project: string; text: string }[] = [];
let autoPin = true;
let actionReads = 0;
let actionSaveGate: Promise<void> | undefined;
let sessionSendGate: Promise<void> | undefined;

function summary(session: Fake) {
	return {
		key: session.key,
		title: session.title,
		project: session.project,
		cwd: session.project,
		recordedBranch: session.branch,
		createdAt: session.updatedAt - 60_000,
		updatedAt: session.updatedAt,
		state: session.state,
		evidence: session.evidence,
		capabilities: {
			rename: yes,
			send: session.state === "unknown" ? { available: false, reason: "codex_not_loaded" } : yes,
			resume: yes,
			openInApp:
				session.key.provider === "codex" ? yes : { available: false, reason: "claude_no_session_link" },
			terminal: { available: false, reason: "codex_daemon_not_running" },
		},
		pinned: session.pinned,
	};
}

function sessionsIpc(request: Record<string, any>) {
	const find = () => {
		const found = sessions.find((s) => s.key.id === request.session.id);
		if (!found) throw { code: "session_not_found", message: "" };
		return found;
	};
	switch (request.action) {
		case "settings":
		case "setAutoPin":
		case "setDiscovery":
			if (request.action === "setDiscovery") discovery = request.enabled;
			if (request.action === "setAutoPin") {
				autoPin = request.enabled;
				revision += 1;
			}
			return {
				revision,
				discoveryEnabled: discovery,
				discoveryProviders: { codex: true, claude: true },
				autoPinNew: autoPin,
				providers: [
					{ provider: "codex", available: true, live: true },
					{ provider: "claude", available: true, live: true },
				],
				storeRecovered: false,
			};
		case "list": {
			const query = request.query;
			const all = sessions.map(summary);
			const filtered = all.filter(
				(s) =>
					(query.scope === "all" || s.pinned) &&
					(!query.search || s.title.toLowerCase().includes(String(query.search).toLowerCase())),
			);
			return {
				discoveryEnabled: discovery,
				sessions: filtered,
				pinnedCount: all.filter((s) => s.pinned).length,
				totalCount: all.length,
				truncated: false,
				issues: [],
			};
		}
		case "pin":
		case "unpin":
			find().pinned = request.action === "pin";
			return { changed: true };
		case "rename":
			find().title = request.title;
			return summary(find());
		case "conversation":
			return [
				{ role: "user", text: "Pourquoi le prix annuel diffère-t-il entre la carte et le paiement ?" },
				{ role: "tool", text: "rg -n roundCurrency src" },
				{
					role: "agent",
					text: [
						"L'arrondi est fait deux fois dans Cedar. Un **double arrondi** :",
						"",
						"- `annualPrice()` arrondit le total annuel ;",
						"- `PlanCard` divise par 12, puis arrondit encore.",
						"",
						"```typescript",
						"export function monthlyShare(plan: Plan): number {",
						"  return annualPrice(plan) / 12;",
						"}",
						"```",
						"",
						'<img src="https://example.invalid/t.png"> J\'applique ce correctif dans `plan-card.tsx` ?',
					].join("\n"),
				},
			];
		case "branch":
			return {
				current: find().branch,
				detached: false,
				options: [
					{ name: find().branch, worktree: null },
					{ name: "main", worktree: null },
					{ name: "dev", worktree: null },
				],
				pending: null,
				sharedWith: [],
			};
		case "create": {
			const created: Fake = {
				key: { provider: request.provider, id: `n${sessions.length}` },
				title: request.title ?? "",
				project: request.project,
				state: "working",
				evidence: "codexDaemon",
				pinned: true,
				updatedAt: Date.now(),
				branch: "feature/annual-billing",
			};
			sessions.push(created);
			createdRequests.push({ provider: request.provider, project: request.project, text: request.text });
			return { session: created.key, receipt: { status: "started", turnId: "n" } };
		}
		case "send":
			sent.push({ id: request.session.id, text: request.text });
			return find().state === "working"
				? { status: "steered", turnId: "t1" }
				: { status: "started", turnId: "t2" };
		case "actions":
			actionReads += 1;
			return { revision, project: request.project ?? null, actions };
		case "terminals":
			return { terminals: [] };
		case "changeActions":
			if (request.revision !== revision) throw { code: "revision_conflict", message: "" };
			revision += 1;
			actions = request.change.actions.map((a: Record<string, unknown>) => ({ ...a, origin: "global" }));
			return { revision };
		case "renderAction": {
			const action = actions.find((a) => a.id === request.actionId)!;
			return {
				text: action.template.replace("{projet}", "Cedar").replace("{branche}", find().branch),
				mode: action.mode,
			};
		}
		default:
			throw { code: "unsupported", message: request.action };
	}
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(8_000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
	if (message.type() === "error") errors.push(message.text());
});
await page.exposeFunction("boaSmokeInvoke", async (command: string, args: Record<string, any> = {}) => {
	if (command.startsWith("plugin:event|")) return 1;
	if (command === "plugin:deep-link|get_current") return null;
	switch (command) {
		case "get_settings":
			return { watchDirectory: null, watchError: null, language: "fr" };
		case "list_projects":
			return projects;
		case "project_summary":
			return { repos: [], scanLimited: false, updatedAt: now / 1000 };
		case "read_directory":
			return [];
		case "repository_web_url":
			return null;
		case "file_workspace":
			return args.request?.action === "preferences"
				? { filtered: false, included: [], pins: [], sort: "name" }
				: { spaces: [], shortcuts: { contextual: "Mod+F", global: "Mod+Shift+F" } };
		case "context_collection_load":
			return null;
		case "sessions_pending_permissions":
			return [];
		case "reader_pending":
			return [];
		case "context_views":
			return [];
		case "editor_integrations":
			return { integrations: [] };
		case "sessions":
			try {
				if (args.request.action === "changeActions") await actionSaveGate;
				const value = sessionsIpc(args.request);
				if (args.request.action === "send") await sessionSendGate;
				return { ok: true, value };
			} catch (error) {
				return { ok: false, value: error };
			}
		default:
			return null;
	}
});
await page.addInitScript(() => {
	localStorage.clear();
	localStorage.setItem("boa-language", "fr");
	Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: {
			metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
			invoke: async (command: string, args: Record<string, unknown>) => {
				const result = await Reflect.get(window, "boaSmokeInvoke")(command, args);
				if (command !== "sessions") return result;
				if (!result.ok) throw result.value;
				return result.value;
			},
			transformCallback: () => 1,
			unregisterCallback: () => {},
		},
	});
});
try {
	await page.goto(process.env.BOA_DEMO_URL ?? "http://localhost:1420");
	await page.getByTestId("sessions-nav").click();
	await expect(page.getByTestId("enable-session-discovery")).toBeVisible();
	await page.screenshot({ path: resolve(output, "01-opt-in.png") });
	await page.getByTestId("enable-session-discovery").click();
	await expect(page.getByTestId("session-row-c1")).toBeVisible();
	await expect(page.getByTestId("session-row-x2")).toHaveCount(0);
	// Sorting by column headers: newest activity first by default, state by attention, persisted.
	const sessionRows = page.getByRole("table", { name: "Sessions" }).getByTestId(/^session-row-/);
	const header = (column: string) => page.getByTestId(`sort-${column}`).locator("xpath=..");
	await expect(header("activity")).toHaveAttribute("aria-sort", "descending");
	await expect(sessionRows.first()).toHaveAttribute("data-testid", "session-row-c1");
	await page.getByTestId("sort-state").click();
	await expect(header("state")).toHaveAttribute("aria-sort", "ascending");
	await expect(sessionRows.first()).toHaveAttribute("data-testid", "session-row-x1");
	await page.getByTestId("sort-title").focus();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Enter");
	await expect(header("title")).toHaveAttribute("aria-sort", "descending");
	await expect(sessionRows.first()).toHaveAttribute("data-testid", "session-row-x1");
	await page.getByTestId("sessions-group").check();
	await expect(page.getByRole("rowgroup", { name: "Cedar", exact: true })).toContainText(
		"Tests du composant PlanCard",
	);
	await page.getByTestId("dashboard-nav").click();
	await page.getByTestId("sessions-nav").click();
	await expect(header("title")).toHaveAttribute("aria-sort", "descending");
	await expect(page.getByTestId("sessions-group")).toBeChecked();
	await page.getByTestId("sessions-group").uncheck();
	await page.getByTestId("sort-activity").click();
	await expect(header("activity")).toHaveAttribute("aria-sort", "descending");
	await page.screenshot({ path: resolve(output, "02-sessions-pinned.png") });

	// Unpin hides from Pinned only; All + search finds and re-pins it.
	await page.getByTestId("session-row-c2").getByRole("button", { name: "Plus d’actions" }).click();
	await page.getByRole("menuitem", { name: "Désépingler" }).click();
	await expect(page.getByTestId("session-row-c2")).toHaveCount(0);
	await page.getByRole("button", { name: /Toutes les sessions/ }).click();
	await page.getByLabel("Rechercher des sessions").fill("export");
	await expect(page.getByTestId("session-row-c2")).toBeVisible();
	await page.getByTestId("session-row-c2").getByRole("button", { name: "Plus d’actions" }).click();
	await page.getByRole("menuitem", { name: "Épingler" }).click();
	await expect(page.getByRole("menu")).toHaveCount(0);
	await page.getByLabel("Rechercher des sessions").fill("");

	// Rename through the … menu; the title changes after the source confirms.
	await page.getByTestId("session-row-x1").getByRole("button", { name: "Plus d’actions" }).click();
	await page.getByRole("menuitem", { name: "Renommer…" }).click();
	await page.getByLabel("Nouveau titre").fill("Tests PlanCard renommés");
	await page.getByRole("button", { name: "Valider" }).click();
	await expect(page.getByTestId("session-row-x1")).toContainText("Tests PlanCard renommés");

	// Dock persists across views with its draft; Send is immediate with a provider receipt.
	await page
		.getByTestId("session-row-c1")
		.getByRole("button", { name: /Remise annuelle/ })
		.dblclick();
	await expect(page.getByTestId("session-dock")).toBeVisible();
	// A second session opens in its own tab; reopening never duplicates; × closes the view only.
	await page
		.getByTestId("session-row-x1")
		.getByRole("button", { name: /Tests PlanCard/ })
		.focus();
	await page.keyboard.press("Enter");
	await page
		.getByTestId("session-row-c1")
		.getByRole("button", { name: /Remise annuelle/ })
		.dblclick();
	const dockTabs = page.getByTestId("session-dock").getByRole("tab");
	await expect(dockTabs).toHaveCount(2);
	await expect(dockTabs.first()).toHaveAttribute("aria-selected", "true");
	await expect(page.getByTestId("session-dock").locator("details")).toContainText("1 action technique");
	await expect(page.getByTestId("session-dock").locator("figure")).toContainText("TypeScript");
	await expect(page.getByTestId("session-dock").locator("img")).toHaveCount(0);
	// Initial height on a fresh profile: the thread shows speakers and messages, not only the last lines.
	await expect(page.getByTestId("session-dock-resizer")).toHaveAttribute("aria-valuenow", "56");
	await expect(page.getByTestId("session-dock").getByText("Vous", { exact: true })).toBeInViewport();
	await expect(page.getByTestId("session-dock").getByRole("button", { name: "Copier" })).toBeInViewport();
	await page.screenshot({ path: resolve(output, "06-dock-tabs-conversation.png") });
	await page.getByTestId("close-session-tab-x1").click();
	await expect(dockTabs).toHaveCount(1);
	await page.getByLabel("Message pour la session").fill("Applique le principe dans Cedar uniquement");
	await page.getByTestId("dashboard-nav").click();
	await page.getByTestId("nav-project-Atlas").click();
	await expect(page.getByLabel("Message pour la session")).toHaveValue(
		"Applique le principe dans Cedar uniquement",
	);
	await page.screenshot({ path: resolve(output, "03-dock-other-project.png") });
	const pendingSend = Promise.withResolvers<void>();
	const sentBefore = sent.length;
	sessionSendGate = pendingSend.promise;
	try {
		const composer = page.getByLabel("Message pour la session");
		await composer.press("Control+Enter");
		await expect.poll(() => sent.length).toBe(sentBefore + 1);
		await expect(page.getByTestId("session-send")).toBeDisabled();
		await composer.press("Control+Enter");
		await composer.press("Meta+Enter");
	} finally {
		pendingSend.resolve();
		sessionSendGate = undefined;
	}
	await expect(page.getByTestId("session-dock")).toContainText("Transmis au tour en cours de Claude Code");
	await expect(page.getByLabel("Message pour la session")).toHaveValue("");
	expect(sent).toHaveLength(sentBefore + 1);
	expect(sent.at(-1)).toEqual({ id: "c1", text: "Applique le principe dans Cedar uniquement" });
	await expect(page.getByRole("button", { name: /Mettre en (file|attente)/ })).toHaveCount(0);
	const remountedSend = Promise.withResolvers<void>();
	const sentBeforeCollapse = sent.length;
	const composer = page.getByLabel("Message pour la session");
	await composer.fill("Vérifie après réduction du dock");
	sessionSendGate = remountedSend.promise;
	try {
		await composer.press("Control+Enter");
		await expect.poll(() => sent.length).toBe(sentBeforeCollapse + 1);
		await page.getByRole("button", { name: "Réduire le dock" }).click();
		await page.getByRole("button", { name: "Afficher le dock" }).click();
		await expect(composer).toHaveValue("Vérifie après réduction du dock");
		await expect(page.getByTestId("session-send")).toBeDisabled();
		await composer.press("Control+Enter");
	} finally {
		remountedSend.resolve();
		sessionSendGate = undefined;
	}
	await expect(composer).toHaveValue("");
	expect(sent).toHaveLength(sentBeforeCollapse + 1);

	// An action in Send mode targets the docked session, with the live branch.
	await page.getByTestId("session-dock").getByRole("button", { name: "Review", exact: true }).click();
	await expect.poll(() => sent.at(-1)?.text).toBe("Relis Cedar sur feature/annual-billing.");

	// The dock height is an app-level split, operable from the keyboard.
	const resizer = page.getByTestId("session-dock-resizer");
	const before = Number(await resizer.getAttribute("aria-valuenow"));
	await resizer.focus();
	await page.keyboard.press("ArrowUp");
	await expect(resizer).toHaveAttribute("aria-valuenow", String(before + 3));

	// New session from a summary: distinct from Resume, prefilled, new id in the same project.
	await page.getByTestId("session-dock").getByRole("button", { name: "Plus d’actions" }).click();
	await page.getByRole("menuitem", { name: "Nouvelle session depuis un résumé" }).click();
	const summaryText = page.getByTestId("session-dock").getByLabel("Message pour la session").first();
	await expect(summaryText).toHaveValue(/L'arrondi est fait deux fois dans Cedar\./);
	await page.screenshot({ path: resolve(output, "05-new-from-summary.png") });
	await page.getByTestId("session-dock").getByRole("button", { name: "Envoyer" }).first().click();
	await expect.poll(() => createdRequests.at(-1)?.project).toBe(projects[0].path);
	expect(createdRequests.at(-1)?.provider).toBe("claude");
	await expect(page.getByTestId("session-dock")).toContainText(
		"Remise annuelle : vérifier l'arrondi (suite)",
	);

	// Settings: edit an action, save, then the dock shows the new label.
	await page.getByRole("button", { name: "Réglages" }).click();
	await expect(page.getByTestId("session-actions-settings")).toBeVisible();
	await page
		.getByTestId("session-actions-settings")
		.getByRole("button", { name: /^Tests/ })
		.click();
	await page.getByTestId("session-actions-settings").getByLabel("Libellé").fill("Tests rapides");
	const actionSettings = page.getByTestId("session-actions-settings");
	const autoPinSwitch = actionSettings.getByRole("switch", { name: /Épingler automatiquement/ });
	const readsBefore = actionReads;
	await autoPinSwitch.click();
	await expect.poll(() => actionReads).toBeGreaterThan(readsBefore);
	await expect(autoPinSwitch).not.toBeChecked();
	await expect(actionSettings.getByLabel("Libellé")).toHaveValue("Tests rapides");
	await page.getByTestId("session-actions-settings").getByLabel("Libellé").scrollIntoViewIfNeeded();
	await page.screenshot({ path: resolve(output, "04-actions-settings.png") });
	const actionSave = Promise.withResolvers<void>();
	actionSaveGate = actionSave.promise;
	try {
		await page.getByRole("button", { name: "Enregistrer" }).click();
		await expect(actionSettings.locator(".actions-layout")).toHaveAttribute("inert", "");
	} finally {
		actionSave.resolve();
		actionSaveGate = undefined;
	}
	await expect(page.getByTestId("session-dock").getByRole("button", { name: "Tests rapides" })).toBeVisible();
	await actionSettings.getByLabel("Libellé").fill("Brouillon local");
	actions = actions.map((action) =>
		action.id === "tests" ? { ...action, label: "Tests externes" } : action,
	);
	revision += 1;
	await autoPinSwitch.click();
	await expect(actionSettings.getByRole("status")).toContainText("Les réglages ont changé");
	await expect(actionSettings.getByLabel("Libellé")).toHaveValue("Brouillon local");
	await expect(actionSettings.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
	await actionSettings.getByRole("button", { name: "Annuler" }).click();
	await expect(actionSettings.getByLabel("Libellé")).toHaveValue("Tests externes");
	expect(errors).toEqual([]);
	console.log(`Session cockpit smoke passed; screenshots in ${output}`);
} catch (error) {
	await page.screenshot({ path: resolve(output, "failure.png") });
	console.error("Page errors:", errors);
	throw error;
} finally {
	await browser.close();
}
