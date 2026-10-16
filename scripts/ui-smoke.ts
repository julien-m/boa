/** Browser UI contracts with mocked Tauri transport and real local attachment files. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const directory = mkdtempSync(join(tmpdir(), "boa-ui-"));
const project = { path: directory, name: "BOA QA", pinned: false, archived: false };
let watchDirectory: string | null = null;
let folderChoice: string | null = directory;
let language = "fr";
let automaticallyDiscovered = false;
const hash = "a".repeat(40);
const otherHash = "c".repeat(40);
const change = { path: "sample.ts", oldPath: null, index: "M", worktree: "M", conflict: false };
const shared = Array.from({ length: 18 }, (_, index) => `const unchanged${index} = ${index};`).join("\n");
const before = `export const amount = 1;\nexport function oldFunction() {\n  return amount;\n}\n${shared}\nexport const tail = 1;\n`;
const after = `export const amount = 2;\nexport function newFunction() {\n  return amount * 2;\n}\n${shared}\nexport const tail = 2;\n`;
const repo = {
	path: directory,
	name: "BOA QA",
	branch: "feature/impact",
	upstream: "origin/main",
	ahead: 2,
	behind: 0,
	changes: [change],
	operation: null,
	error: null,
};
let registeredProjects: (typeof project)[] = [];
let summaryCalls = 0;
let projectListCalls = 0;
let historyCalls = 0;
let clipboard = "";
let exportsCreated = 0;
const browser = await chromium.launch({
	channel: process.env.BOA_TEST_BROWSER === "chromium" ? undefined : "chrome",
	headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.exposeFunction("boaTestInvoke", async (command: string, args: Record<string, unknown> = {}) => {
	if (command === "plugin:event|listen") return 1;
	if (command.startsWith("plugin:event|")) return null;
	if (command === "plugin:deep-link|get_current") return null;
	if (command === "plugin:clipboard-manager|write_text") {
		clipboard = String(args.text);
		return null;
	}
	if (command === "plugin:drag|start_drag") {
		// No automatic drag-out is used by the composer.
		return null;
	}
	if (command === "plugin:dialog|open") return folderChoice;
	switch (command) {
		case "list_projects":
			projectListCalls++;
			if (
				watchDirectory &&
				automaticallyDiscovered &&
				!registeredProjects.some((item) => item.name === "Auto QA")
			)
				registeredProjects.push({ ...project, path: `${directory}/auto`, name: "Auto QA" });
			return registeredProjects;
		case "get_settings":
			return { watchDirectory, watchError: null, language };
		case "set_language":
			language = String(args.language);
			return { watchDirectory, watchError: null, language };
		case "set_watch_directory":
			watchDirectory = args.path as string | null;
			return { watchDirectory, watchError: null, language };
		case "archive_project":
			registeredProjects = registeredProjects.map((item) =>
				item.path === args.project ? { ...item, archived: Boolean(args.archived) } : item,
			);
			return null;
		case "add_project":
			if (args.path !== directory) throw new Error("Unexpected import path");
			registeredProjects = [{ ...project, ...registeredProjects[0], archived: false }];
			return registeredProjects[0];
		case "pin_project":
			registeredProjects = registeredProjects.map((item) => ({ ...item, pinned: Boolean(args.pinned) }));
			return null;
		case "project_summary":
			summaryCalls++;
			return { repos: [repo], scanLimited: false };
		case "read_directory":
			return [
				"sample.ts",
				"README.md",
				"config.json",
				"config.xml",
				"config.yaml",
				"wrangler.toml",
				"wrangler.jsonc",
			].map((name) => ({
				name,
				path: name,
				directory: false,
				symlink: false,
				repository: false,
			}));
		case "read_file":
			return {
				original: "",
				modified:
					args.path === "README.md"
						? "# Mon document\n\nUne **lecture claire**.\n\n| Nom | État |\n| --- | --- |\n| BOA | Prêt |\n\n```ts\nconst value = 1;\n```\n\n<script>window.boaUnsafe = true</script>"
						: args.path === "config.json"
							? '{ "name": "BOA", "count": 2, "enabled": true }'
							: args.path === "config.xml"
								? '<project enabled="true"><name>BOA</name></project>'
								: args.path === "config.yaml"
									? "name: BOA\ncount: 2\nenabled: true\n# commentaire"
									: args.path === "wrangler.toml"
										? '# Wrangler\nname = "boa"\nworkers_dev = true\n[env.production]\ncompatibility_date = "2026-10-15"'
										: args.path === "wrangler.jsonc"
											? '// Wrangler\n{ "name": "boa", "workers_dev": true }'
											: after,
				path: String(args.path),
				label: "Lecture seule",
			};
		case "git_diff":
			return {
				original: before,
				modified: after,
				path: "sample.ts",
				label: (args.request as { hash?: string })?.hash
					? `Commit ${(args.request as { hash: string }).hash}`
					: "Avant → après",
			};

		case "git_branches":
			return [
				{ name: "main", current: false, remote: false },
				{ name: "feature/impact", current: true, remote: false },
			];
		case "git_history":
			historyCalls++;
			return [
				{
					hash: args.branch === "main" ? otherHash : hash,
					parents: [],
					author: "BOA QA",
					date: "2026-10-15T12:00:00+02:00",
					subject: "Modifier le calcul",
					refs: "HEAD -> feature/impact",
				},
			];
		case "git_commit_files":
			return [change];
		case "search_project":
			return {
				matches: [{ path: "sample.ts", line: 2, text: "export function newFunction()" }],
				limited: false,
				warning: null,
			};
		case "compare_branch":
			return { base: "main", head: hash, mergeBase: "b".repeat(40), changes: [change] };
		case "resolve_navigation":
			return { project: directory, path: "sample.ts" };
		case "export_context": {
			exportsCreated++;
			const markdownPath = join(directory, "context.md");
			const imagePath = join(directory, "code.png");
			writeFileSync(markdownPath, String(args.prompt));
			writeFileSync(imagePath, Buffer.from(String(args.image).split(",")[1], "base64"));
			return { markdownPath, imagePath };
		}
		default:
			throw new Error(`Unexpected IPC: ${command}`);
	}
});
await page.addInitScript(() => {
	const callbacks = new Map<number, (event: unknown) => void>();
	const listeners = new Map<string, number>();
	let callbackId = 1;
	Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: {
			invoke: (command: string, args: Record<string, unknown>) => {
				if (command === "plugin:event|listen") {
					listeners.set(String(args.event), Number(args.handler));
					return Promise.resolve(args.handler);
				}
				return Reflect.get(window, "boaTestInvoke")(command, args);
			},
			transformCallback: (callback: (event: unknown) => void) => {
				const id = callbackId++;
				callbacks.set(id, callback);
				return id;
			},
			unregisterCallback: (id: number) => callbacks.delete(id),
		},
	});
	const emit = (event: string, payload: unknown): void => {
		const id = listeners.get(event);
		if (id) callbacks.get(id)?.({ event, id, payload });
	};
	Reflect.set(window, "boaTestNavigate", (urls: string[]) => emit("deep-link://new-url", urls));
	Reflect.set(window, "boaTestProjectsChanged", () => emit("boa:projects-changed", null));
	Reflect.set(window, "boaTestFilesystemChanged", (payload: unknown) =>
		emit("boa:filesystem-changed", payload),
	);
});
try {
	await page.clock.install();
	await page.goto("http://localhost:1420");
	await expect(page.getByTestId("empty-add-project")).toBeVisible();
	await expect(page.getByText("Aucun dossier n’est parcouru avant votre sélection.")).toBeVisible();
	expect(summaryCalls).toBe(0);
	await page.getByTestId("settings-nav").click();
	await expect(page.getByTestId("discovery-mode")).toHaveText("Manuelle");
	folderChoice = null;
	await page.getByTestId("choose-watch-directory").click();
	await expect(page.getByTestId("discovery-mode")).toHaveText("Manuelle");
	folderChoice = directory;
	await page.getByTestId("choose-watch-directory").click();
	await expect(page.getByTestId("watch-directory")).toContainText(directory);
	await expect(page.getByTestId("discovery-mode")).toHaveText("Automatique");
	await page.getByTestId("disable-watch-directory").click();
	await expect(page.getByTestId("discovery-mode")).toHaveText("Manuelle");
	await page.getByTestId("dashboard-nav").click();
	await page.getByTestId("empty-add-project").click();
	await expect(page.getByTestId("project-view")).toBeVisible();
	await page.getByTestId("dashboard-nav").click();
	await expect(page.getByTestId("project-card-BOA QA")).toBeVisible();
	await expect(page.getByTestId("pin-project-BOA QA")).toHaveAttribute("aria-pressed", "false");
	await page.getByTestId("pin-project-BOA QA").click();
	await expect(page.getByTestId("nav-project-BOA QA")).toBeVisible();
	await page.getByTestId("archive-project-BOA QA").click();
	await expect(page.getByTestId("project-card-BOA QA")).toHaveCount(0);
	await expect(page.getByTestId("nav-project-BOA QA")).toHaveCount(0);
	await page.getByTestId("archives-nav").click();
	await expect(page.getByTestId("archived-BOA QA")).toBeVisible();
	await page.getByTestId("restore-BOA QA").click();
	await expect(page.getByTestId("archived-BOA QA")).toHaveCount(0);
	await page.getByTestId("dashboard-nav").click();
	await expect(page.getByTestId("nav-project-BOA QA")).toBeVisible();
	await page.getByTestId("archive-project-BOA QA").click();
	await page.getByTestId("add-project").click();
	await expect(page.getByTestId("project-view")).toBeVisible();
	await page.getByTestId("dashboard-nav").click();
	registeredProjects = registeredProjects.map((item) => ({ ...item, pinned: false }));
	await page.evaluate(() => Reflect.get(window, "boaTestProjectsChanged")());
	await expect(page.getByTestId("pin-project-BOA QA")).toHaveAttribute("aria-pressed", "false");
	await page.getByTestId("pin-project-BOA QA").click();
	await expect(page.getByTestId("dashboard-counts")).toContainText("2");
	await page.getByTestId("project-sort").selectOption("recent");
	await page.getByTestId("project-display").selectOption("list");
	await page.getByTestId("open-project-BOA QA").click();
	await page.getByTestId("file-README.md").click();
	await expect(
		page.getByTestId("markdown-preview").getByRole("heading", { name: "Mon document" }),
	).toBeVisible();
	await expect(page.getByTestId("markdown-preview").getByRole("table")).toContainText("Prêt");
	await page.getByTestId("create-context").click();
	await expect(page.getByTestId("context-popover")).toBeVisible();
	await expect(page.getByTestId("context-file")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("context-selection")).toBeDisabled();
	const buttonBounds = await page.getByTestId("create-context").boundingBox();
	const dialogBounds = await page.getByTestId("context-popover").boundingBox();
	expect(dialogBounds?.y).toBeGreaterThan((buttonBounds?.y ?? 0) + (buttonBounds?.height ?? 0));
	await page.getByTestId("context-message").fill("Explique ce document");
	await page.getByTestId("save-context").click();
	await expect(page.getByTestId("context-popover")).toHaveCount(0);
	expect(clipboard).toContain(`${directory}/README.md`);
	expect(clipboard).toContain("Explique ce document");
	expect(clipboard).not.toContain("Mon document");
	expect(clipboard).not.toContain("const value");
	await page.keyboard.press("Control+Shift+b");
	await expect(page.getByTestId("context-message")).toHaveValue("");
	await page.locator(".file-sidebar .pane-heading").click({ position: { x: 10, y: 10 } });
	await expect(page.getByTestId("context-popover")).toHaveCount(0);
	// Selecting rendered Markdown must also work without pretending to know source line numbers.
	await page.evaluate(() => {
		const element = document.querySelector('[data-testid="markdown-preview"] strong');
		if (!element) throw new Error("Markdown text absent");
		const range = document.createRange();
		range.selectNodeContents(element);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
	});
	await page.getByTestId("create-context").click();
	await expect(page.getByTestId("context-excerpt")).toHaveText("lecture claire");
	await page.getByTestId("context-message").fill("Explique cette sélection");
	await page.getByTestId("save-context").click();
	expect(clipboard).toContain("lecture claire");
	expect(clipboard).not.toContain("Lignes :");
	await page.keyboard.press("Control+Shift+b");
	await expect(page.getByTestId("context-popover")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("context-popover")).toHaveCount(0);

	expect(await page.evaluate(() => Reflect.get(window, "boaUnsafe"))).toBeUndefined();
	await expect(page.getByTestId("copy-ai-context")).toBeDisabled();
	await page.getByTestId("markdown-toggle").click();
	await expect(page.getByTestId("markdown-preview")).toHaveCount(0);
	await expect(page.locator(".monaco-editor").first()).toBeVisible();
	await page.getByTestId("markdown-toggle").click();
	await expect(page.getByTestId("markdown-preview")).toBeVisible();
	const moduleSource = await (await page.request.get("http://localhost:1420/src/code-viewer.tsx")).text();
	const monacoPath = moduleSource.match(/import \* as monaco from "([^"]+)"/u)?.[1];
	if (!monacoPath) throw new Error("Monaco import unavailable");
	for (const [path, language] of [
		["config.json", "json"],
		["config.xml", "xml"],
		["config.yaml", "yaml"],
		["wrangler.toml", "toml"],
		["wrangler.jsonc", "json"],
	]) {
		await page.getByTestId(`file-${path}`).click();
		await expect
			.poll(() =>
				page.evaluate(
					async ({ monacoPath, language }) => {
						const module = await import(monacoPath);
						const model = module.editor
							.getModels()
							.find((model: { getLanguageId: () => string }) => model.getLanguageId() === language);
						if (!model) return 0;
						return new Set(
							module.editor
								.tokenize(model.getValue(), language)
								.flat()
								.map((token: { type: string }) => token.type),
						).size;
					},
					{ monacoPath, language },
				),
			)
			.toBeGreaterThan(2);
	}
	await page.getByTestId("file-sample.ts").click();
	await expect(page.getByTestId("code-viewer")).toContainText("sample.ts");
	const grip = page.getByTestId("git-resizer");
	const beforeHeight = await page.getByTestId("git-panel").evaluate((e) => e.clientHeight);
	await grip.press("ArrowUp");
	const afterHeight = await page.getByTestId("git-panel").evaluate((e) => e.clientHeight);
	expect(afterHeight).toBeGreaterThan(beforeHeight);
	await page.getByTestId("layout-files").click();
	await expect(page.getByTestId("git-panel")).toHaveCount(0);
	await page.keyboard.press("Control+Shift+f");
	await expect(page.getByTestId("project-search-input")).toBeFocused();
	await page.getByTestId("project-search-input").fill("newFunction");
	await page.getByTestId("project-search-submit").click();
	await page.getByTestId("search-result-0").click();
	await page.getByTestId("toggle-project-search").click();
	await page.getByTestId("toggle-file-tree").click();
	await expect(page.getByTestId("file-sample.ts")).toHaveCount(0);
	await page.getByTestId("layout-git").click();
	await expect(page.getByTestId("code-viewer")).toContainText("sample.ts");
	await expect(page.getByRole("textbox", { name: /modifié/i })).toBeAttached();
	const widthGrip = page.getByTestId("git-width-resizer");
	const initialWidth = await page.locator(".git-content").evaluate((element) => element.clientWidth);
	await widthGrip.press("ArrowRight");
	expect(await page.locator(".git-content").evaluate((element) => element.clientWidth)).toBeGreaterThan(
		initialWidth,
	);
	const gripBounds = await widthGrip.boundingBox();
	if (!gripBounds) throw new Error("Width splitter absent");
	await page.mouse.move(gripBounds.x + 3, gripBounds.y + 60);
	await page.mouse.down();
	await page.mouse.move(gripBounds.x + 80, gripBounds.y + 60);
	await page.mouse.up();
	const persistedWidth = await page.evaluate(() => localStorage.getItem("boa-git-width"));
	expect(Number(persistedWidth)).toBeGreaterThan(45);
	await page.getByTestId("layout-files").click();
	await page.getByTestId("layout-git").click();
	await expect(widthGrip).toHaveAttribute("aria-valuenow", String(Math.round(Number(persistedWidth))));

	await page.getByTestId("change-sample.ts").first().click();
	await page.getByTestId("diff-layout").click();

	const selectOriginal = async (startLine: number, endLine: number): Promise<void> => {
		await page.evaluate(
			async ({ monacoPath, startLine, endLine }) => {
				const module = await import(monacoPath);
				const editor = module.editor
					.getEditors()
					.find((candidate: { getModel: () => { getValue: () => string } | null }) =>
						candidate.getModel()?.getValue().includes("oldFunction"),
					);
				if (!editor) throw new Error("Original editor absent");
				editor.focus();
				editor.setSelection(new module.Range(startLine, 1, endLine, 1000));
			},
			{ monacoPath, startLine, endLine },
		);
	};
	await expect(page.getByRole("textbox", { name: /original/i })).toBeAttached();
	await expect
		.poll(() =>
			page.evaluate(async (path) => {
				const module = await import(path);
				return module.editor.getDiffEditors()[0]?.getLineChanges()?.length ?? 0;
			}, monacoPath),
		)
		.toBe(2);
	const diffLine = async (): Promise<number> =>
		page.evaluate(async (path) => {
			const module = await import(path);
			return module.editor.getDiffEditors()[0].getModifiedEditor().getPosition().lineNumber;
		}, monacoPath);
	await page.getByTestId("diff-next").click();
	const firstDiffLine = await diffLine();
	await page.getByTestId("diff-next").click();
	const secondDiffLine = await diffLine();
	expect(secondDiffLine).not.toBe(firstDiffLine);
	await page.getByTestId("diff-previous").click();
	expect(await diffLine()).toBe(firstDiffLine);

	await selectOriginal(1, 4);
	await page.getByTestId("create-context").click();
	await page.getByTestId("context-message").fill("Explique la version avant modification.");
	await selectOriginal(2, 2);
	await expect(page.getByTestId("context-popover")).toContainText("L2–2");
	await expect(page.getByTestId("context-message")).toHaveValue("Explique la version avant modification.");
	await page.getByTestId("context-message").press("Enter");
	await expect(page.getByTestId("context-popover")).toHaveCount(0);
	expect(clipboard).toContain("oldFunction");
	expect(clipboard).not.toContain("export const amount");
	expect(clipboard).toContain("Avant");
	expect(clipboard).toContain(project.path);
	await page.getByTestId("create-context").click();
	await page.getByTestId("context-file").click();
	await page.getByTestId("context-message").fill("Regarde le fichier entier");
	await page.getByTestId("save-context").click();
	expect(clipboard).toContain(`${directory}/sample.ts`);
	expect(clipboard).not.toContain("oldFunction");
	expect(exportsCreated).toBe(0);
	await expect(page.getByTestId("show-contexts")).toHaveCount(0);
	await page.getByTestId("create-context").click();
	await expect(page.getByTestId("context-message")).toHaveValue("");
	await page.getByTestId("close-contexts").click();

	await page.getByTestId("git-history-tab").click();
	await page.getByTestId(`commit-${hash}`).click();
	await expect(page.getByTestId("commit-details")).toContainText("Modifier le calcul");
	await page.getByTestId("change-sample.ts").click();
	await expect(page.getByTestId("code-viewer")).toContainText(`Commit ${hash}`);
	await page.getByTestId(`commit-${hash}`).click();
	await expect(page.getByTestId("code-viewer")).toContainText(`Commit ${hash}`);
	await page.getByTestId("history-branch").selectOption("main");
	await expect(page.getByTestId("preview-empty")).toBeVisible();
	await expect(page.getByTestId(`commit-${otherHash}`)).toBeVisible();
	await page.getByTestId("change-sample.ts").click();
	await expect(page.getByTestId("code-viewer")).toContainText(`Commit ${otherHash}`);
	await expect(page.getByTestId("change-sample.ts")).toHaveClass(/selected/);

	await page.getByTestId("git-compare-tab").click();
	await page.getByTestId("compare-head").selectOption("feature/impact");
	await page.getByTestId("branch-change-sample.ts").click();
	await page.evaluate(
		(path) =>
			Reflect.get(
				window,
				"boaTestNavigate",
			)([`boa://open?file=${encodeURIComponent(`${path}/sample.ts`)}&line=2&endLine=3&source=Codex`]),
		directory,
	);
	await expect(page.getByTestId("guidance-toggle")).toContainText("Codex");
	await expect(page.getByTestId("layout-files")).toHaveAttribute("aria-pressed", "true");
	await page.getByTestId("guidance-toggle").click();
	await expect(page.getByTestId("guidance-toggle")).toContainText("suspendu");
	await page.getByTestId("settings-nav").click();
	await page.getByTestId("choose-watch-directory").click();
	await expect(page.getByTestId("discovery-mode")).toHaveText("Automatique");
	automaticallyDiscovered = true;
	await page.getByTestId("dashboard-nav").click();
	const idleSummaries = summaryCalls;
	const idleLists = projectListCalls;
	await page.clock.fastForward(120_000);
	expect(summaryCalls).toBe(idleSummaries);
	expect(projectListCalls).toBe(idleLists);
	await expect(page.getByTestId("project-card-Auto QA")).toHaveCount(0);
	await page.evaluate(() =>
		Reflect.get(window, "boaTestFilesystemChanged")({ discovery: true, settings: false, projects: [] }),
	);
	await expect(page.getByTestId("project-card-Auto QA")).toBeVisible();
	const beforeGitEvent = summaryCalls;
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect.poll(() => summaryCalls).toBe(beforeGitEvent + 1);
	await page.getByTestId("archive-project-Auto QA").click();
	await page.evaluate(() =>
		Reflect.get(window, "boaTestFilesystemChanged")({ discovery: true, settings: false, projects: [] }),
	);
	await expect(page.getByTestId("project-card-Auto QA")).toHaveCount(0);
	await page.getByTestId("settings-nav").click();
	await page.getByTestId("interface-language").selectOption("en");
	await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
	await expect(page.getByTestId("dashboard-nav")).toContainText("Overview");
	await expect(page.locator("html")).toHaveAttribute("lang", "en");
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "settings-en.png") });
	repo.path = `${directory}/nested-repo`;
	await page.reload();
	await expect(page.getByTestId("dashboard-nav")).toContainText("Overview");
	await page.getByTestId("archives-nav").click();
	await expect(page.getByRole("heading", { name: "Archives", exact: true })).toBeVisible();
	await expect(page.getByTestId("restore-Auto QA")).toContainText("Restore");
	await page.getByTestId("dashboard-nav").click();
	await page.getByTestId("open-project-BOA QA").click();
	await page.getByTestId("layout-git").click();
	await page.getByTestId("git-history-tab").click();
	await expect(page.getByTestId(`commit-${hash}`)).toBeVisible();
	const previousHistoryCalls = historyCalls;
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect.poll(() => historyCalls).toBe(previousHistoryCalls + 1);
	await expect(page.getByTestId("layout-files")).toContainText("Files");
	await page.getByTestId("layout-files").click();
	await page.getByTestId("file-README.md").click();
	await page.getByTestId("create-context").click();
	await expect(page.getByTestId("context-popover")).toContainText("Context to share");
	await page.getByTestId("context-message").fill("Explain this file");
	await page.getByTestId("save-context").click();
	expect(clipboard).toContain("Project:");
	expect(clipboard).not.toContain("Projet :");
	await page.getByTestId("settings-nav").click();
	await page.getByTestId("interface-language").selectOption("fr");
	await expect(page.getByRole("heading", { name: "Réglages", exact: true })).toBeVisible();
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "settings-fr.png") });
	expect(errors).toEqual([]);
	console.log(
		"PASS: fichiers, Git, contexte, navigation, réglages, événements natifs, aucun polling, archives/restauration, FR/EN et langue persistée au rechargement. Transport Tauri mocké.",
	);
} finally {
	await browser.close();
	rmSync(directory, { recursive: true, force: true });
}
