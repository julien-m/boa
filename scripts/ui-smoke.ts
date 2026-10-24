/** Browser UI contracts with mocked Tauri transport and real local attachment files. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

async function navigateHistory(direction: "back" | "forward") {
	await page.evaluate(
		(button) => {
			window.dispatchEvent(new MouseEvent("mousedown", { button, bubbles: true, cancelable: true }));
			window.dispatchEvent(new MouseEvent("mouseup", { button, bubbles: true, cancelable: true }));
			window.dispatchEvent(new MouseEvent("auxclick", { button, bubbles: true, cancelable: true }));
		},
		direction === "back" ? 3 : 4,
	);
}

const directory = mkdtempSync(join(tmpdir(), "boa-ui-"));
const project = { path: directory, name: "BOA QA", pinned: false, archived: false };
let fileSpaces: { id: string; name: string; roots: string[]; files?: string[] }[] = [];
const filePreferences: Record<
	string,
	{ filtered: boolean; included: string[]; pins: string[]; sort: string }
> = {};
let searchShortcuts = { contextual: "Mod+F", global: "Mod+Shift+F" };
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
let remoteUrl: string | null = "https://github.com/example/project";
const openedFolders: string[] = [];
const openedRepositories: string[] = [];
let clipboard = "";
const comparisonRequests: Record<string, unknown>[] = [];
const finderRequests: Record<string, unknown>[] = [];
let savedContent: string | null = null;
let markdownExtra = "";
let saveConflict = false;
let summaryGate: Promise<void> | null = null;
let releaseSummary = (): void => {};
let exportsCreated = 0;
const browser = await chromium.launch({
	channel: process.env.BOA_TEST_BROWSER === "chromium" ? undefined : "chrome",
	headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.route("https://example.com/tracking.png", async (route) => {
	expect(route.request().headers().referer).toBeUndefined();
	await route.fulfill({ contentType: "image/png", body: readFileSync("src-tauri/icons/32x32.png") });
});
await page.route("http://example.com/badge.svg", (route) =>
	route.fulfill({
		contentType: "image/svg+xml",
		body: '<svg xmlns="http://www.w3.org/2000/svg" width="90" height="20"><rect width="90" height="20" fill="green"/></svg>',
	}),
);
await page.route("https://example.com/missing.png", (route) => route.fulfill({ status: 404 }));
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
		case "reveal_file":
			finderRequests.push(args);
			return null;
		case "choose_comparison_image":
			comparisonRequests.push(args);
			return {
				dataUrl: `data:image/png;base64,${readFileSync("src-tauri/icons/32x32.png").toString("base64")}`,
				name: "version-b.png",
				size: 100,
			};
		case "file_workspace": {
			const request = args.request as Record<string, unknown>;
			const root = String(request.root ?? "");
			if (request.action === "list") return { spaces: fileSpaces, shortcuts: searchShortcuts };
			if (request.action === "preferences")
				return filePreferences[root] ?? { filtered: false, included: [], pins: [], sort: "name" };
			if (request.action === "images")
				return {
					images: (fileSpaces.some((s) => s.files?.includes(root))
						? [root.split("/").pop()!]
						: ["preview.png", "preview-second.png"]
					).map((name, index) => ({
						name,
						path: name,
						format: "png",
						modified: 1,
						added: index + 1,
						size: 100,
					})),
					limited: false,
				};
			if (request.action === "thumbnail")
				return `data:image/png;base64,${readFileSync("src-tauri/icons/32x32.png").toString("base64")}`;
			if (request.action === "set-preferences") {
				filePreferences[root] = request.preferences as (typeof filePreferences)[string];
				return filePreferences[root];
			}
			if (request.action === "add-to-space") {
				const existing = fileSpaces.find((s) => s.id === request.id);
				const full = fileSpaces.some((s) => s.files?.includes(root)) ? root : `${root}/${request.path}`;
				const space = existing ?? {
					id: String(request.id),
					name: String(request.name),
					roots: [],
					files: [],
				};
				space.files = [...new Set([...(space.files ?? []), full])];
				if (!existing) fileSpaces.push(space);
				return space;
			}
			if (request.action === "save-space") {
				fileSpaces = [
					...fileSpaces.filter((s) => s.id !== request.id),
					{
						id: String(request.id),
						name: String(request.name),
						roots: request.roots as string[],
						files: request.files as string[] | undefined,
					},
				];
				return fileSpaces.at(-1);
			}
			if (request.action === "remove-space") {
				fileSpaces = fileSpaces.filter((s) => s.id !== request.id);
				return true;
			}
			if (request.action === "set-shortcuts") {
				searchShortcuts = request.shortcuts as typeof searchShortcuts;
				return searchShortcuts;
			}
			if (request.action === "search")
				return {
					matches: [
						{
							project: directory,
							path: "sample.ts",
							line: 1,
							text: after.split("\n")[0],
							directory: false,
							kind: "content",
						},
					],
					limited: false,
					warning: "",
				};
			throw new Error("Unknown file command");
		}

		case "read_markdown_image":
			expect(args.document).toBe("README.md");
			expect(args.source).toBe("images/plan.png");
			return `data:image/png;base64,${readFileSync("src-tauri/icons/32x32.png").toString("base64")}`;
		case "repository_web_url":
			return remoteUrl;
		case "open_repository":
			openedRepositories.push(String(args.repo));
			return null;
		case "open_project_folder":
			openedFolders.push(String(args.project));
			return null;
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
		case "add_project": {
			const existing = registeredProjects.find((item) => item.path === args.path);
			if (!existing && args.path !== directory) throw new Error("Unexpected import path");
			const added = { ...project, ...existing, archived: false };
			registeredProjects = existing
				? registeredProjects.map((item) => (item.path === added.path ? added : item))
				: [...registeredProjects, added];
			return added;
		}
		case "pin_project":
			registeredProjects = registeredProjects.map((item) => ({ ...item, pinned: Boolean(args.pinned) }));
			return null;
		case "project_summary":
			if (summaryGate) await summaryGate;
			summaryCalls++;
			return { repos: [repo], scanLimited: false };
		case "read_directory":
			if (fileSpaces.some((s) => s.files?.includes(String(args.project)))) {
				const name = String(args.project).split("/").pop()!;
				return [{ name, path: name, directory: false, symlink: false, repository: false }];
			}
			return [
				"sample.ts",
				"README.md",
				"config.json",
				"config.xml",
				"config.yaml",
				"wrangler.toml",
				"wrangler.jsonc",
				"preview.png",
				"preview-second.png",
			].map((name) => ({
				name,
				path: name,
				directory: false,
				symlink: false,
				repository: false,
			}));
		case "save_file":
			if (saveConflict) throw new Error("Le fichier a changé sur le disque.");
			await new Promise((resolve) => setTimeout(resolve, 100));
			savedContent = String(args.content);
			return null;
		case "read_file":
			if (args.path === "docs/linked.md")
				return {
					original: "",
					modified:
						"# Document lié\n\n" +
						"Un paragraphe avant la section.\n\n".repeat(40) +
						"## Section\n\n[Retour au document](../README.md#mon-document)\n\n" +
						"Après la section.\n\n".repeat(30),
					path: String(args.path),
					label: "Lecture seule",
				};
			if (["preview.png", "preview-second.png"].includes(String(args.path))) {
				const icon = readFileSync("src-tauri/icons/32x32.png");
				// Distinct decoded sources ensure browsing actually remounts the shared image reader.
				const source =
					args.path === "preview-second.png"
						? `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${icon.readUInt32BE(16)}" height="${icon.readUInt32BE(20)}"><rect width="100%" height="100%" fill="royalblue"/></svg>`)}`
						: `data:image/png;base64,${icon.toString("base64")}`;
				return {
					original: "",
					modified: "",
					path: String(args.path),
					label: "Lecture seule",
					kind: "image",
					dataUrl: source,
				};
			}
			return {
				original: "",
				modified:
					args.path === "README.md"
						? markdownExtra +
							'# Mon document\n\n[Ouvrir la section liée](docs/linked.md#section) · [Même document](#mon-document)\n\nUne **lecture claire**.\n\n![Plan](images/plan.png)\n\n![Remote](https://example.com/tracking.png)\n\n<p><a href="https://example.com"><img src="http://example.com/badge.svg" alt="Quality badge" width="90" height="40" onerror="window.boaUnsafe = true"></a></p>\n\n<img src="http://example.com/badge.svg" alt="Large illustration" width="1200" height="800">\n\n<img src="http://example.com/badge.svg" alt="Height only" height="40">\n\n![Unavailable](https://example.com/missing.png)\n\n<iframe src="https://example.com/frame"></iframe>\n\n| Nom | État |\n| --- | --- |\n| BOA | Prêt |\n\n```ts\nconst value = 1;\n```\n\n<script>window.boaUnsafe = true</script>'
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
											: args.path === "sample.ts"
												? (savedContent ?? after)
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
			metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
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
	Reflect.set(window, "boaTestHistoryNavigate", (direction: number) =>
		emit("boa:history-navigation", direction),
	);
	Reflect.set(window, "boaTestProjectsChanged", () => emit("boa:projects-changed", null));
	Reflect.set(window, "boaTestFilesystemChanged", (payload: unknown) =>
		emit("boa:filesystem-changed", payload),
	);
});
try {
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
	await page.getByTestId("open-project-folder").click();
	await expect.poll(() => openedFolders.at(-1)).toBe(directory);
	await page.getByTestId("open-repository").click();
	await expect.poll(() => openedRepositories.at(-1)).toBe(directory);
	remoteUrl = null;
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect(page.getByTestId("open-repository")).toBeDisabled();
	await page.mouse.move(0, 0);
	await page.getByTestId("open-repository").hover();
	await expect(page.getByRole("tooltip")).toHaveText("Aucun dépôt distant web configuré");
	await page.mouse.move(0, 0);
	remoteUrl = "https://github.com/example/project";
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect(page.getByTestId("open-repository")).toBeEnabled();
	await page.getByTestId("dashboard-nav").click();
	await expect(page.getByTestId("project-card-BOA QA")).toBeVisible();
	const layoutBeforeNavigation = await page.evaluate(() => localStorage.getItem("boa-layout") ?? "split");
	await expect(page.getByTestId("navigate-back")).toHaveCount(0);
	await expect(page.getByTestId("navigate-forward")).toHaveCount(0);
	// Overview typing starts the search from a focused navigation button, including the first key.
	await page.keyboard.type("BOA");
	await expect(page.getByTestId("project-search")).toBeFocused();
	await expect(page.getByTestId("project-search")).toHaveValue("BOA");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("project-search")).toHaveValue("");
	await page.getByTestId("project-sort").focus();
	await page.keyboard.press("n");
	await expect(page.getByTestId("project-search")).toHaveValue("");
	await page.getByTestId("project-card-BOA QA").click();
	await page.getByTestId("layout-files").click();
	await page.getByTestId("file-sample.ts").click();
	await page.getByTestId("file-README.md").click();
	// Logitech macOS gestures arrive through AppKit/Tauri, not DOM mouse buttons.
	await page.evaluate(() => Reflect.get(window, "boaTestHistoryNavigate")(-1));
	await expect(page.getByTestId("tab-sample.ts")).toHaveAttribute("aria-selected", "true");
	await page.evaluate(() => Reflect.get(window, "boaTestHistoryNavigate")(1));
	await expect(page.getByTestId("tab-README.md")).toHaveAttribute("aria-selected", "true");
	await page.evaluate(() => Reflect.get(window, "boaTestHistoryNavigate")(0));
	await expect(page.getByTestId("tab-README.md")).toHaveAttribute("aria-selected", "true");
	await navigateHistory("back");
	await expect(page.getByTestId("tab-sample.ts")).toHaveAttribute("aria-selected", "true");
	await navigateHistory("forward");
	await expect(page.getByTestId("tab-README.md")).toHaveAttribute("aria-selected", "true");

	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "navigation-history.png") });
	await page.getByRole("button", { name: "Bibliothèque", exact: true }).click();
	await expect(page.locator(".image-library")).toBeVisible();
	await navigateHistory("back");
	await expect(page.locator(".workspace-reader")).toBeVisible();
	await navigateHistory("forward");
	await expect(page.locator(".image-library")).toBeVisible();
	await page.getByTestId("dashboard-nav").click();
	await navigateHistory("back");
	await expect(page.getByTestId("project-view")).toBeVisible();
	await expect(page.locator(".image-library")).toBeVisible();
	await navigateHistory("forward");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await page.getByTestId("settings-nav").click();
	await page.keyboard.press("Alt+ArrowLeft");
	await expect(page.getByTestId("dashboard")).toBeVisible();
	await navigateHistory("forward");
	await expect(page.getByTestId("discovery-mode")).toBeVisible();
	await navigateHistory("back");
	await page.getByTestId("project-card-BOA QA").click();
	// Restored directory requests must browse a folder, never create a file tab.
	await page.evaluate(
		(project) =>
			window.dispatchEvent(
				new CustomEvent("boa:open-file", {
					detail: { project, path: "docs/", navigationId: crypto.randomUUID() },
				}),
			),
		directory,
	);
	await expect(page.locator('.file-browser button[data-hint="docs"]')).toBeVisible();
	await page.getByTestId("dashboard-nav").click();
	await navigateHistory("back");
	await expect(page.locator('.file-browser button[data-hint="docs"]')).toBeVisible();
	await expect(page.getByTestId("tab-docs/")).toHaveCount(0);
	await page.getByTestId("layout-git").click();
	await expect(page.getByTestId("git-panel")).toBeVisible();
	await navigateHistory("back");
	await expect(page.getByTestId("project-view")).toHaveClass(/layout-files/);
	await navigateHistory("forward");
	await expect(page.getByTestId("project-view")).toHaveClass(/layout-git/);
	await page.getByTestId(`layout-${layoutBeforeNavigation}`).click();
	await page.getByTestId("dashboard-nav").click();
	await expect(page.getByTestId("pin-project-BOA QA")).toHaveAttribute("aria-pressed", "false");
	await page.getByTestId("pin-project-BOA QA").click();
	await expect(page.getByTestId("nav-project-BOA QA")).toBeVisible();
	await page.getByTestId("nav-project-BOA QA").click();
	await page.getByTestId("layout-files").click();
	await page.getByTestId("file-sample.ts").click();
	await page.getByTestId("nav-project-BOA QA").click();
	await page.getByTestId("settings-nav").click();
	await navigateHistory("back");
	await expect(page.getByTestId("tab-sample.ts")).toHaveAttribute("aria-selected", "true");
	await page.getByTestId(`layout-${layoutBeforeNavigation}`).click();
	await page.getByTestId("dashboard-nav").click();
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
	const dashboardSearch = page.getByTestId("project-search");
	await dashboardSearch.fill("absent");
	await page.locator(".search-field .search-clear").click();
	await expect(dashboardSearch).toHaveValue("");
	await expect(dashboardSearch).toBeFocused();
	await dashboardSearch.fill("BOA");
	await dashboardSearch.press("Escape");
	await expect(dashboardSearch).toHaveValue("");
	await expect(dashboardSearch).toBeFocused();
	await page.getByTestId("project-sort").selectOption("recent");
	await page.getByTestId("project-display").selectOption("list");
	await page.getByTestId("open-project-BOA QA").click();
	await page.getByTestId("file-README.md").click();
	await expect(
		page.getByTestId("markdown-preview").getByRole("heading", { name: "Mon document" }),
	).toBeVisible();
	await expect(page.getByTestId("markdown-preview").getByRole("table")).toContainText("Prêt");
	const followMarkdown = async () => {
		await page.getByTestId("markdown-preview").getByRole("link", { name: "Ouvrir la section liée" }).click();
		await expect(page.getByTestId("code-viewer")).toContainText("docs/linked.md");
		await expect(page.getByRole("tab", { name: "linked.md", exact: true })).toBeVisible();
		await expect
			.poll(() => page.locator(".markdown-scroll").evaluate((node) => node.scrollTop))
			.toBeGreaterThan(300);
		await expect
			.poll(() =>
				page.locator("#section").evaluate((node) => {
					const container = node.closest(".markdown-scroll")!;
					return Math.round(node.getBoundingClientRect().top - container.getBoundingClientRect().top);
				}),
			)
			.toBe(24);
		await page.getByTestId("markdown-preview").getByRole("link", { name: "Retour au document" }).click();
		await expect(
			page.getByTestId("markdown-preview").getByRole("heading", { name: "Mon document" }),
		).toBeVisible();
	};
	await followMarkdown();
	await page.getByTestId("close-tab-docs/linked.md").click();
	await page.getByTestId("close-tab-README.md").click();
	await page.getByTestId("file-README.md").click();

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
	await expect(page.getByRole("img", { name: "Plan", exact: true })).toBeVisible();
	await expect
		.poll(() =>
			page
				.getByRole("img", { name: "Plan", exact: true })
				.evaluate((image) => (image as HTMLImageElement).naturalWidth),
		)
		.toBe(32);
	await expect
		.poll(() =>
			page
				.getByRole("img", { name: "Remote", exact: true })
				.evaluate((image) => (image as HTMLImageElement).naturalWidth),
		)
		.toBe(32);
	await expect
		.poll(() =>
			page
				.getByRole("img", { name: "Quality badge", exact: true })
				.evaluate((image) => (image as HTMLImageElement).naturalWidth),
		)
		.toBe(90);
	await expect(page.getByRole("img", { name: "Quality badge", exact: true })).toHaveAttribute("width", "90");
	await expect(page.getByRole("img", { name: "Quality badge", exact: true })).toHaveAttribute("height", "40");
	const badgeBounds = await page.getByRole("img", { name: "Quality badge", exact: true }).boundingBox();
	expect(badgeBounds?.width).toBe(90);
	expect(badgeBounds?.height).toBe(40);
	const largeBounds = await page.getByRole("img", { name: "Large illustration", exact: true }).boundingBox();
	expect(largeBounds?.width).toBeLessThan(1200);
	expect(largeBounds?.height).toBeCloseTo(((largeBounds?.width ?? 0) * 800) / 1200, 1);
	await expect
		.poll(() =>
			page
				.getByRole("img", { name: "Height only", exact: true })
				.evaluate((image) => image.getBoundingClientRect().height),
		)
		.toBe(40);
	await expect(page.getByRole("img", { name: "Quality badge", exact: true })).not.toHaveAttribute("onerror");
	await expect(page.locator(".markdown-image").filter({ hasText: "Unavailable" })).toBeVisible();
	await expect(page.locator(".markdown-preview iframe, .markdown-preview script")).toHaveCount(0);
	expect(await page.evaluate(() => Reflect.get(window, "boaUnsafe"))).toBeUndefined();
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
	expect(await page.getByTestId("code-viewer").evaluate((e) => e.clientHeight)).toBeGreaterThan(200);
	// Temporary previews replace each other; retained tabs survive and close independently.
	await expect(page.getByRole("tab")).toHaveCount(1);
	await page.getByTestId("file-README.md").click();
	await expect(page.getByTestId("tab-sample.ts")).toHaveCount(0);
	await page.getByTestId("file-README.md").dblclick();
	await page.getByTestId("file-sample.ts").click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await page.getByTestId("file-sample.ts").dblclick();
	await page.getByTestId("tab-README.md").click();
	await expect(page.getByTestId("markdown-preview")).toBeVisible();
	await page.getByTestId("close-tab-README.md").click();
	await expect(page.getByTestId("tab-sample.ts")).toHaveAttribute("aria-selected", "true");
	await page.getByTestId("close-tab-sample.ts").click();
	await expect(page.getByTestId("preview-empty")).toBeVisible();
	await page.getByTestId("file-sample.ts").click();
	// A filesystem event refreshes the reader without returning to the start.
	await expect
		.poll(() =>
			page.evaluate(async (path) => {
				const module = await import(path);
				const reader = module.editor
					.getEditors()
					.find((e: { getDomNode: () => HTMLElement }) =>
						e.getDomNode()?.closest('[data-testid="code-viewer"]'),
					);
				return reader?.getLayoutInfo().height ?? 0;
			}, monacoPath),
		)
		.toBeGreaterThan(200);
	const visibleBefore = await page.evaluate(async (path) => {
		const module = await import(path);
		const reader = module.editor
			.getEditors()
			.find((e: { getDomNode: () => HTMLElement }) => e.getDomNode()?.closest('[data-testid="code-viewer"]'));
		reader.setScrollTop(reader.getTopForLineNumber(16), 1);
		const line = reader.getVisibleRanges()[0].startLineNumber;
		return reader.getModel().getLineContent(line);
	}, monacoPath);
	savedContent = Array.from({ length: 8 }, (_, i) => `// inserted ${i}`).join("\n") + "\n" + after;
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect
		.poll(() =>
			page.evaluate(async (path) => {
				const module = await import(path);
				const reader = module.editor
					.getEditors()
					.find((e: { getDomNode: () => HTMLElement }) =>
						e.getDomNode()?.closest('[data-testid="code-viewer"]'),
					);
				return reader.getModel().getValue().startsWith("// inserted");
			}, monacoPath),
		)
		.toBe(true);
	await expect
		.poll(() =>
			page.evaluate(async (path) => {
				const module = await import(path);
				const reader = module.editor
					.getEditors()
					.find((e: { getDomNode: () => HTMLElement }) =>
						e.getDomNode()?.closest('[data-testid="code-viewer"]'),
					);
				return reader.getModel().getLineContent(reader.getVisibleRanges()[0].startLineNumber);
			}, monacoPath),
		)
		.toBe(visibleBefore);
	savedContent = null;
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect
		.poll(() =>
			page.evaluate(async (path) => {
				const module = await import(path);
				return module.editor
					.getModels()
					.some((m: { getValue: () => string }) => m.getValue().startsWith("// inserted"));
			}, monacoPath),
		)
		.toBe(false);
	await page.getByTestId("file-README.md").click();
	await page.getByRole("heading", { name: "Mon document" }).scrollIntoViewIfNeeded();
	const headingBefore = await page
		.getByRole("heading", { name: "Mon document" })
		.evaluate((e) => e.getBoundingClientRect().top);
	markdownExtra = "# Inserted before\n\n" + "An extra paragraph.\n\n".repeat(20);
	await page.evaluate(
		(project) =>
			Reflect.get(
				window,
				"boaTestFilesystemChanged",
			)({ discovery: false, settings: false, projects: [project] }),
		directory,
	);
	await expect(page.getByRole("heading", { name: "Inserted before" })).toBeAttached();
	expect(
		await page.getByRole("heading", { name: "Mon document" }).evaluate((e) => e.getBoundingClientRect().top),
	).toBeCloseTo(headingBefore, -1);
	await page.getByTestId("read-only-toggle").click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByTestId("read-only-toggle")).toHaveAttribute("aria-pressed", "true");
	await page.getByTestId("edit-cancel").click();
	await expect(page.getByRole("heading", { name: "Mon document" })).toBeVisible();
	expect(
		await page.getByRole("heading", { name: "Mon document" }).evaluate((e) => e.getBoundingClientRect().top),
	).toBeCloseTo(headingBefore, -1);
	await page.getByTestId("file-sample.ts").click();
	const originalReader = await page.evaluate(async (path) => {
		const module = await import(path);
		const reader = module.editor
			.getEditors()
			.find((e: { getDomNode: () => HTMLElement }) => e.getDomNode()?.closest('[data-testid="code-viewer"]'));
		reader.layout();
		reader.setScrollTop(reader.getTopForLineNumber(16), 1);
		reader.setPosition({ lineNumber: 16, column: 4 });
		Reflect.set(window, "boaOriginalReader", reader);
		return reader.getScrollTop();
	}, monacoPath);
	await page.getByTestId("read-only-toggle").click();
	await expect(page.getByTestId("edit-save")).toBeDisabled();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	expect(await page.evaluate(() => Reflect.get(window, "boaOriginalReader").getScrollTop())).toBe(
		originalReader,
	);
	await expect(page.getByTestId("read-only-toggle")).toHaveAttribute("aria-pressed", "true");
	expect(
		await page.evaluate(async (path) => {
			const module = await import(path);
			return module.editor.getEditors().includes(Reflect.get(window, "boaOriginalReader"));
		}, monacoPath),
	).toBe(true);
	const editInput = page.getByTestId("code-viewer").getByRole("textbox");
	await editInput.press("ControlOrMeta+End");
	await editInput.press("Enter");
	await page.keyboard.insertText("// local edit");
	await expect(page.getByTestId("edit-dirty")).toBeVisible();
	await page.getByTestId("edit-cancel").click();
	await page.getByTestId("edit-discard").click();
	expect(savedContent).toBeNull();
	await page.getByTestId("read-only-toggle").click();
	await editInput.press("ControlOrMeta+End");
	await editInput.press("Enter");
	await page.keyboard.insertText("// saved edit");
	const retainedPosition = await page.evaluate(async (path) => {
		const module = await import(path);
		const reader = module.editor
			.getEditors()
			.find((e: { getDomNode: () => HTMLElement }) => e.getDomNode()?.closest('[data-testid="code-viewer"]'));
		Reflect.set(window, "boaRetainedModel", reader.getModel());
		return { cursor: reader.getPosition(), scroll: reader.getScrollTop() };
	}, monacoPath);
	await page.getByTestId("file-README.md").click();
	await expect(page.getByTestId("draft-indicator")).toBeVisible();
	await page.getByTestId("tab-sample.ts").click();
	await expect(page.getByTestId("read-only-toggle")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("edit-dirty")).toBeVisible();
	const restoredPosition = await page.evaluate(async (path) => {
		const module = await import(path);
		const reader = module.editor
			.getEditors()
			.find((e: { getDomNode: () => HTMLElement }) => e.getDomNode()?.closest('[data-testid="code-viewer"]'));
		return {
			sameModel: reader.getModel() === Reflect.get(window, "boaRetainedModel"),
			cursor: reader.getPosition(),
			scroll: reader.getScrollTop(),
		};
	}, monacoPath);
	expect(restoredPosition.sameModel).toBe(true);
	expect(restoredPosition.cursor).toEqual(retainedPosition.cursor);
	expect(restoredPosition.scroll).toBeCloseTo(retainedPosition.scroll, 0);
	await editInput.press("ControlOrMeta+z");
	await expect
		.poll(() =>
			page.evaluate(() => Reflect.get(window, "boaRetainedModel").getValue().includes("// saved edit")),
		)
		.toBe(false);
	await editInput.press("ControlOrMeta+Shift+z");
	await expect
		.poll(() =>
			page.evaluate(() => Reflect.get(window, "boaRetainedModel").getValue().includes("// saved edit")),
		)
		.toBe(true);
	await page.getByTestId("file-README.md").click();
	await page.getByTestId("draft-indicator").locator("summary").click();
	await page.getByTestId("draft-indicator").getByRole("button", { name: "sample.ts", exact: true }).click();
	await expect(page.getByTestId("edit-dirty")).toBeVisible();

	saveConflict = true;
	await page.getByTestId("edit-save").click();
	await expect(page.getByTestId("code-viewer")).toContainText("Le fichier a changé");
	await expect(editInput).toBeEditable();
	saveConflict = false;
	summaryGate = new Promise<void>((resolve) => {
		releaseSummary = resolve;
	});
	await page.getByTestId("edit-cancel").click();
	await expect(page.getByTestId("edit-discard")).toBeVisible();
	await editInput.press("ControlOrMeta+s");
	await expect(page.getByTestId("edit-discard")).toHaveCount(0);
	await expect(page.getByTestId("read-only-toggle")).toHaveAttribute("aria-pressed", "false");
	releaseSummary();
	summaryGate = null;
	expect(savedContent).toContain("// saved edit");
	await page.getByTestId("layout-split").click();
	const treeGrip = page.getByTestId("file-tree-resizer");
	const treeBefore = await page.locator(".file-sidebar").evaluate((e) => e.clientWidth);
	const treeBounds = await treeGrip.boundingBox();
	if (!treeBounds) throw new Error("File tree splitter missing");
	await page.mouse.move(treeBounds.x + 3, treeBounds.y + 40);
	await page.mouse.down();
	await page.mouse.move(treeBounds.x + 100, treeBounds.y + 40);
	await page.mouse.up();
	await expect
		.poll(() => page.locator(".file-sidebar").evaluate((e) => e.clientWidth), { timeout: 2000 })
		.toBeGreaterThan(treeBefore);
	const savedTreeWidth = await page.evaluate(() => localStorage.getItem("boa-tree-width"));
	const grip = page.getByTestId("git-resizer");
	const beforeHeight = await page.getByTestId("git-panel").evaluate((e) => e.clientHeight);
	await grip.press("ArrowUp");
	const afterHeight = await page.getByTestId("git-panel").evaluate((e) => e.clientHeight);
	expect(afterHeight).toBeGreaterThan(beforeHeight);
	await page.getByTestId("layout-files").click();
	await expect(page.getByTestId("git-panel")).toHaveCount(0);
	expect(await treeGrip.getAttribute("aria-valuenow")).toBe(String(Math.round(Number(savedTreeWidth))));
	const filesTreeBefore = await page.locator(".file-sidebar").evaluate((e) => e.clientWidth);
	await treeGrip.press("ArrowRight");
	await expect
		.poll(() => page.locator(".file-sidebar").evaluate((e) => e.clientWidth), { timeout: 2000 })
		.toBeGreaterThan(filesTreeBefore);

	await expect(page.getByTestId("toggle-project-search")).toHaveCount(0);
	await page.locator("[data-file-browser]").focus();
	await page.keyboard.type("sample");
	const speedSearch = page.locator(".tree-speed-search input");
	await expect(speedSearch).toHaveValue("sample");
	await page.locator(".tree-speed-search .search-results button").first().click();
	await speedSearch.press("Escape");
	await expect(speedSearch).toHaveValue("");
	await expect(speedSearch).toBeFocused();
	await expect(page.locator(".tree-speed-search")).toBeVisible();
	await speedSearch.fill("sample");
	await page.locator(".tree-speed-search .search-clear").click();
	await expect(speedSearch).toHaveValue("");
	await expect(speedSearch).toBeFocused();
	await speedSearch.press("Escape");
	await expect(page.locator(".tree-speed-search")).toHaveCount(0);
	await page.getByTestId("toggle-file-tree").click();
	await expect(page.getByTestId("file-sample.ts")).toBeHidden();
	await expect(page.getByTestId("toggle-file-tree")).toBeVisible();
	await page.getByTestId("toggle-file-tree").click();
	await expect(page.getByTestId("file-sample.ts")).toBeVisible();
	await page.getByTestId("toggle-file-tree").click();
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
	await expect(page.getByTestId("diff-layout")).toHaveAccessibleName(/Diff|diff/);
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
	// Install the clock only for the no-polling assertion: its Performance mock
	// does not implement the User Timing entries Monaco measures during typing.
	await page.clock.install();
	await page.clock.fastForward(120_000);
	expect(summaryCalls).toBe(idleSummaries);
	expect(projectListCalls).toBe(idleLists);
	await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
	await page.clock.fastForward(1_000);
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
	const beforeRestore = summaryCalls;
	await page.getByTestId("archives-nav").click();
	await page.getByTestId("restore-Auto QA").click();
	await expect.poll(() => summaryCalls).toBe(beforeRestore + 1);
	await page.getByTestId("dashboard-nav").click();
	await page.getByTestId("archive-project-Auto QA").click();
	await page.evaluate(
		(project) =>
			window.dispatchEvent(
				new CustomEvent("boa:open-file", {
					detail: { project, path: "sample.ts", anchor: "", navigationId: crypto.randomUUID() },
				}),
			),
		`${directory}/auto`,
	);
	await expect(page.getByTestId("project-view")).toBeVisible();
	await expect(page.locator(".project-header")).toContainText("Auto QA");
	expect(registeredProjects.find((item) => item.name === "Auto QA")?.archived).toBe(false);
	await page.getByTestId("dashboard-nav").click();
	await page.getByTestId("archive-project-Auto QA").click();
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
	await expect(page.getByTestId("open-repository")).toContainText("Open repository");
	await page.getByTestId("open-repository").click();
	await expect.poll(() => openedRepositories.at(-1)).toBe(repo.path);
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

	// File spaces and contextual search share the real tree/editor with project views.
	await page.getByRole("button", { name: "Nouvel espace", exact: true }).last().click();
	await page.getByLabel("Nom", { exact: true }).fill("Outils QA");
	await page.getByRole("button", { name: "Ajouter un dossier", exact: true }).click();
	await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
	await expect.poll(() => fileSpaces.length).toBe(1);
	await page.getByRole("button", { name: "Outils QA", exact: true }).click();
	await expect(page.getByTestId("file-space-view")).toBeVisible();
	await page.getByTestId("file-sample.ts").click();
	await expect(page.getByTestId("code-viewer")).toContainText("sample.ts");
	await page.getByRole("button", { name: "Épingler sample.ts", exact: true }).click();
	await expect.poll(() => filePreferences[directory]?.pins).toEqual(["sample.ts"]);
	await page.getByTestId("file-sample.ts").focus();
	await page.keyboard.press("Control+f");
	await expect(page.getByTestId("file-search-panel")).toBeVisible();
	await page.getByRole("textbox", { name: "Rechercher", exact: true }).fill("sample");
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("file-search-panel")).toContainText("sample.ts");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("textbox", { name: "Rechercher", exact: true })).toHaveValue("");
	await expect(page.getByTestId("file-search-panel")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("file-search-panel")).toHaveCount(0);
	await page.keyboard.press("Control+Shift+f");
	const globalSearch = page.getByRole("dialog", { name: "Recherche globale" });
	await expect(globalSearch).toBeVisible();
	await globalSearch.getByRole("textbox").fill("sample");
	await globalSearch.locator(".search-clear").click();
	await expect(globalSearch.getByRole("textbox")).toHaveValue("");
	await globalSearch.getByRole("textbox").fill("sample");
	await page.keyboard.press("Escape");
	await expect(globalSearch).toBeVisible();
	await expect(globalSearch.getByRole("textbox")).toBeFocused();
	await expect(globalSearch.getByRole("textbox")).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(globalSearch).toHaveCount(0);
	await page.getByRole("button", { name: "Visibilité et tri", exact: true }).click();
	await page.getByRole("button", { name: "Choisir les éléments visibles", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: "Choisir sample.ts", exact: true })).toBeVisible();
	expect(filePreferences[directory]?.filtered ?? false).toBe(false);
	await page.locator(".file-browser-options").getByRole("button", { name: "Fermer", exact: true }).click();
	await expect(page.getByTestId("file-config.json")).toBeVisible();
	await page.getByRole("button", { name: "Visibilité et tri", exact: true }).click();
	await page.getByRole("combobox", { name: "Trier par", exact: true }).selectOption("modified-asc");
	await expect.poll(() => filePreferences[directory]?.sort).toBe("modified-asc");
	await page.getByRole("button", { name: "Choisir les éléments visibles", exact: true }).click();
	await page.getByRole("button", { name: "Désépingler sample.ts", exact: true }).click();
	await expect.poll(() => filePreferences[directory]?.pins).toEqual([]);
	expect(filePreferences[directory]?.filtered).toBe(false);
	await page.getByRole("button", { name: "Épingler sample.ts", exact: true }).click();
	await expect.poll(() => filePreferences[directory]?.pins).toEqual(["sample.ts"]);
	expect(filePreferences[directory]?.filtered).toBe(false);
	const selectedItem = page.getByRole("checkbox", { name: "Choisir sample.ts", exact: true });
	await expect(selectedItem).not.toBeChecked();
	await expect(selectedItem).toBeEnabled();
	await selectedItem.check();
	await expect.poll(() => filePreferences[directory]?.included).toEqual(["sample.ts"]);
	await page.locator(".file-browser-options").getByRole("button", { name: "Fermer", exact: true }).click();
	await expect(page.getByTestId("file-config.json")).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: "Outils QA", exact: true }).click();
	await expect(page.locator(".tree-pins")).toContainText("sample.ts");
	await page.getByRole("button", { name: "Visibilité et tri", exact: true }).click();
	await expect(page.getByRole("combobox", { name: "Trier par", exact: true })).toHaveValue("modified-asc");
	await page.getByRole("checkbox", { name: "Sélection visible", exact: true }).uncheck();
	await expect.poll(() => filePreferences[directory]?.filtered).toBe(false);
	await page.getByRole("button", { name: "Choisir les éléments visibles", exact: true }).click();
	await expect(page.getByRole("checkbox", { name: "Choisir sample.ts", exact: true })).toBeChecked();
	await page.locator(".file-browser-options").getByRole("button", { name: "Fermer", exact: true }).click();
	filePreferences[directory] = { filtered: true, included: [], pins: ["sample.ts"], sort: "modified-asc" };
	await page.reload();
	await page.getByRole("button", { name: "Outils QA", exact: true }).click();
	await page.getByRole("button", { name: "Tout afficher", exact: true }).click();
	await expect.poll(() => filePreferences[directory]?.filtered).toBe(false);
	await expect(page.getByTestId("file-README.md")).toBeVisible();
	await page.evaluate(
		(project) =>
			window.dispatchEvent(
				new CustomEvent("boa:open-file", {
					detail: { project, path: "docs/", navigationId: crypto.randomUUID() },
				}),
			),
		directory,
	);
	await expect(page.locator('.file-browser button[data-hint="docs"]')).toBeVisible();
	await navigateHistory("back");
	await expect(page.locator('.file-browser button[data-hint="docs"]')).toHaveCount(0);
	await navigateHistory("forward");
	await expect(page.locator('.file-browser button[data-hint="docs"]')).toBeVisible();
	await page.getByRole("button", { name: "Outils QA", exact: true }).click();
	await page.getByTestId("settings-nav").click();
	await navigateHistory("back");
	await expect(page.locator('.file-browser button[data-hint="docs"]')).toBeVisible();
	await page.locator(".file-browser-root").click();
	await page.getByTestId("file-sample.ts").click();
	await page.getByTestId("read-only-toggle").click();
	const spaceEditor = page.getByTestId("code-viewer").getByRole("textbox");
	await spaceEditor.press("ControlOrMeta+End");
	await page.keyboard.insertText("// preserved space draft");
	await expect(page.getByTestId("edit-dirty")).toBeVisible();
	await page.getByTestId("file-README.md").click();
	await followMarkdown();
	await page.getByRole("tab", { name: "sample.ts •", exact: true }).click();
	await expect(page.getByTestId("edit-dirty")).toBeVisible();
	await expect(page.locator(".view-lines")).toContainText("// preserved space draft");
	await page.getByTestId("edit-cancel").click();
	await page.getByTestId("edit-discard").click();

	await page.getByTestId("settings-nav").click();
	await page.getByRole("textbox", { name: "Recherche contextuelle", exact: true }).press("Control+g");
	await expect.poll(() => searchShortcuts.contextual).toBe("Mod+G");
	await page.getByRole("button", { name: "Modifier l’espace", exact: true }).click();
	folderChoice = `${directory}/second`;
	await page.getByRole("button", { name: "Ajouter un dossier", exact: true }).click();
	await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
	await expect.poll(() => fileSpaces[0].roots.length).toBe(2);
	await page.getByRole("button", { name: "Outils QA", exact: true }).click();
	const browsers = page.locator("[data-file-browser]");
	await browsers.nth(0).getByTestId("file-sample.ts").dblclick();
	await browsers.nth(1).getByTestId("file-sample.ts").dblclick();
	await expect(page.getByRole("tab", { name: "sample.ts", exact: true })).toHaveCount(2);
	await browsers.nth(1).getByTestId("file-sample.ts").focus();
	await page.keyboard.press("Control+g");
	await expect(page.getByTestId("file-search-panel")).toBeVisible();
	await page.keyboard.press("Escape");
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "file-space.png") });

	// Real layout and navigation: scoped gallery, multiword filter, lightbox and explicit file access.
	await browsers.nth(1).getByRole("button", { name: "Images de ce dossier", exact: true }).click();
	await expect(page.locator(".image-library")).toBeVisible();
	await expect
		.poll(() => page.locator(".image-library").evaluate((node) => node.getBoundingClientRect().height))
		.toBeGreaterThan(150);
	await expect(page.locator(".library-thumbnail img").first()).toBeVisible();
	const librarySort = page.locator('.image-library select[aria-label="Trier par"]');
	await librarySort.selectOption("added");
	await expect.poll(() => filePreferences[`${directory}/second`]?.sort).toBe("added");
	await expect(page.locator(".library-image").first()).toHaveAttribute("aria-label", "preview-second.png");
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "image-library-sorting.png") });
	await librarySort.selectOption("added-asc");
	await expect(page.locator(".library-image").first()).toHaveAttribute("aria-label", "preview.png");
	await librarySort.selectOption("name");
	await page.getByLabel("Format d’image", { exact: true }).selectOption("png");
	await page.getByRole("searchbox", { name: "Filtrer les images…", exact: true }).fill("preview + png");
	await expect(page.locator(".library-card")).toHaveCount(2);
	const libraryFilter = page.getByRole("searchbox", { name: "Filtrer les images…", exact: true });
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "image-library.png") });
	await page.locator(".image-library .search-clear").click();
	await expect(libraryFilter).toHaveValue("");
	await expect(libraryFilter).toBeFocused();
	await libraryFilter.fill("absent");
	await libraryFilter.press("Escape");
	await expect(libraryFilter).toHaveValue("");
	await expect(libraryFilter).toBeFocused();
	await libraryFilter.fill("preview + png");
	const libraryTile = page.locator(".library-image").first();
	const libraryPath = (await libraryTile.getAttribute("aria-label"))!;
	const nextLibraryPath = (await page.locator(".library-image").nth(1).getAttribute("aria-label"))!;
	await libraryTile.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Afficher dans Finder", exact: true }).click();
	await expect
		.poll(() => finderRequests.at(-1))
		.toEqual({ project: `${directory}/second`, path: libraryPath });
	await expect(page.locator(".image-library")).toBeVisible();
	await expect(libraryTile).toBeFocused();
	await libraryTile.press("Shift+F10");
	await expect(page.getByRole("menu", { name: "Actions du fichier", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(libraryTile).toBeFocused();
	await libraryTile.click();
	const lightbox = page.getByRole("dialog", { name: "Prévisualisation des images", exact: true });
	await expect(lightbox).toBeVisible();
	await expect(page.locator(".workspace-reader")).toBeHidden();
	await expect(lightbox.locator("img")).toHaveAttribute("alt", libraryPath);
	await expect
		.poll(() => lightbox.locator(".image-viewport").evaluate((node) => node.getBoundingClientRect().height))
		.toBeGreaterThan(150);
	await lightbox.getByRole("button", { name: "Plein écran", exact: true }).click();
	await expect
		.poll(() => lightbox.evaluate((node) => Math.round(node.getBoundingClientRect().width)))
		.toBe(1440);
	await lightbox.getByRole("button", { name: "Taille réelle (100 %)", exact: true }).click();
	await lightbox.getByRole("button", { name: "Agrandir l’image", exact: true }).click();
	await expect(lightbox.locator("img")).toHaveCSS("width", "40px");
	await lightbox.evaluate((dialog) => {
		const first = dialog.querySelector("img")!;
		const ratio = first.getBoundingClientRect().width / first.naturalWidth;
		const violations: string[] = [];
		const sources = new Set<string>();
		let frame = 0;
		const sample = () => {
			const image = dialog.querySelector("img");
			if (image && getComputedStyle(image).visibility === "visible" && image.naturalWidth) {
				sources.add(image.src);
				if (Math.abs(image.getBoundingClientRect().width - image.naturalWidth * ratio) > 0.5)
					violations.push(image.style.width);
			}
			frame = requestAnimationFrame(sample);
		};
		sample();
		Reflect.set(window, "boaScaleFrames", { violations, sources, stop: () => cancelAnimationFrame(frame) });
	});
	await page.keyboard.press("ArrowRight");
	await expect(lightbox.locator("img")).toHaveAttribute("alt", nextLibraryPath);
	await expect(lightbox).toHaveClass(/fullscreen/);
	await expect(lightbox.locator("img")).toHaveCSS("width", "40px");
	await page.evaluate(
		() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
	);
	await page.keyboard.press("PageUp");
	await expect(lightbox.locator("img")).toHaveAttribute("alt", libraryPath);
	await expect(lightbox.locator("img")).toHaveCSS("width", "40px");
	await expect(lightbox.locator(".image-facts")).toHaveText("32 × 32 px · 100 o");
	const frames = await page.evaluate(async () => {
		await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
		const frames = Reflect.get(window, "boaScaleFrames");
		frames.stop();
		return { violations: frames.violations, sources: frames.sources.size };
	});
	expect(frames.violations).toEqual([]);
	expect(frames.sources).toBeGreaterThan(1);
	await lightbox.locator(".image-viewport").click({ button: "right" });
	await expect(lightbox.getByRole("menuitem", { name: "Afficher dans Finder", exact: true })).toBeVisible();
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "library-finder-menu.png") });
	await lightbox.getByRole("menuitem", { name: "Afficher dans Finder", exact: true }).click();
	await expect
		.poll(() => finderRequests.at(-1))
		.toEqual({ project: `${directory}/second`, path: libraryPath });
	await expect(lightbox).toBeVisible();
	if (process.env.BOA_QA_OUTPUT)
		await page.screenshot({ path: join(process.env.BOA_QA_OUTPUT, "image-scale.png") });
	await lightbox.getByLabel("Fond de l’image", { exact: true }).selectOption("checkerboard");
	await expect(lightbox.locator(".image-canvas")).toHaveCSS("background-image", /conic-gradient/);
	await lightbox.getByRole("slider", { name: "Niveau de zoom", exact: true }).evaluate((node) => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, "800");
		node.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await lightbox.getByRole("button", { name: "Grille de pixels", exact: true }).click();
	await expect(lightbox.locator(".image-pixel-grid")).toHaveCSS("background-size", "8px 8px, 8px 8px");
	await lightbox.getByRole("button", { name: "Pipette · copier une couleur", exact: true }).click();
	await lightbox.locator(".image-pixel-surface img").click({ position: { x: 128, y: 128 } });
	await expect.poll(() => clipboard).toMatch(/^#[0-9A-F]{6}([0-9A-F]{2})?$/);
	await expect(lightbox.locator(".image-sample")).toContainText("Couleur copiée");
	await lightbox.getByRole("button", { name: "Comparer deux images", exact: true }).click();
	const comparison = page.getByRole("dialog", { name: "Comparer deux images", exact: true });
	await expect(comparison).toBeVisible();
	await comparison.getByRole("button", { name: "Choisir une deuxième image", exact: true }).click();
	await expect
		.poll(() => comparisonRequests.at(-1))
		.toEqual({ project: `${directory}/second`, directory: "" });
	await expect(comparison.locator(".image-comparison-canvas img")).toHaveCount(2);
	await comparison.getByRole("button", { name: "Superposition", exact: true }).click();
	await comparison.getByRole("slider", { name: "Part visible de la deuxième image", exact: true }).focus();
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowRight");
	await expect(comparison.locator(".image-comparison-overlay")).toHaveCSS("clip-path", /99%/);
	await expect(lightbox.locator(".image-pixel-surface img")).toHaveAttribute("alt", libraryPath);
	await page.keyboard.press("Escape");
	await expect(comparison).toHaveCount(0);
	await expect(lightbox).toBeVisible();
	await lightbox.getByRole("button", { name: "Image suivante", exact: true }).focus();
	await expect(lightbox.getByRole("tooltip")).toHaveText("Image suivante · → Page ↓");
	await page.keyboard.press("Escape");
	await expect(lightbox).toHaveCount(0);
	await expect(page.locator(".image-library")).toBeVisible();
	await expect(page.getByRole("searchbox", { name: "Filtrer les images…", exact: true })).toHaveValue(
		"preview + png",
	);
	await page.locator(".library-image").first().click();
	await lightbox.getByRole("button", { name: "Ouvrir dans Fichiers", exact: true }).click();
	await expect(page.locator(".workspace-reader")).toBeVisible();
	await browsers.nth(1).getByTestId("file-preview.png").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Plein écran", exact: true }).click();
	const fullscreenImage = page.getByRole("dialog", { name: "preview.png", exact: true });
	await expect(fullscreenImage).toBeVisible();
	await fullscreenImage.getByRole("button", { name: "Taille réelle (100 %)", exact: true }).click();
	await fullscreenImage.getByRole("button", { name: "Agrandir l’image", exact: true }).click();
	await expect(fullscreenImage.locator("img")).toHaveCSS("width", "40px");
	await page.keyboard.press("Escape");
	await expect(fullscreenImage).toHaveCount(0);
	await page.getByRole("button", { name: "Bibliothèque", exact: true }).click();
	await page
		.getByRole("button", { name: "Retrouver dans l’arborescence : preview.png", exact: true })
		.click();
	await expect(browsers.nth(1).getByTestId("file-preview.png")).toBeFocused();
	await page.getByTestId("toggle-file-tree").focus();
	await expect(browsers.nth(1).getByTestId("file-preview.png")).toHaveClass(/selected/);
	await expect(browsers.nth(1).getByTestId("file-preview.png")).toHaveCSS(
		"background-color",
		"rgb(48, 62, 96)",
	);

	const imageRow = browsers.nth(1).getByTestId("file-preview.png");
	await imageRow.click({ button: "right" });
	await expect(page.getByRole("menu", { name: "Actions du fichier" })).toBeVisible();
	await page.getByRole("menuitem", { name: "Afficher dans Finder", exact: true }).click();
	await expect
		.poll(() => finderRequests.at(-1))
		.toEqual({ project: `${directory}/second`, path: "preview.png" });
	await imageRow.focus();
	await page.keyboard.press("Shift+F10");
	await page.getByRole("menuitem", { name: "Copier le nom", exact: true }).click();
	await expect.poll(() => clipboard).toBe("preview.png");
	await expect(imageRow).toHaveClass(/selected/);
	await imageRow.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Comparer deux images", exact: true }).click();
	await expect(comparison).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(comparison).toHaveCount(0);

	await imageRow.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Ajouter à un espace de fichiers…", exact: true }).click();
	const addSpace = page.getByRole("dialog", { name: "Ajouter à un espace de fichiers…", exact: true });
	await expect(addSpace.getByLabel("Nom", { exact: true })).toHaveValue("preview.png");
	await expect(addSpace.getByLabel("Chemin de l’élément", { exact: true })).toHaveValue(
		`${directory}/second/preview.png`,
	);
	await addSpace.getByRole("button", { name: "Créer un espace…", exact: true }).click();
	await expect(addSpace).toHaveCount(0);
	await expect
		.poll(() => fileSpaces.find((s) => s.name === "preview.png")?.files)
		.toEqual([`${directory}/second/preview.png`]);
	await imageRow.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Ajouter à un espace de fichiers…", exact: true }).click();
	await addSpace
		.getByLabel("Espace de fichiers", { exact: true })
		.selectOption(fileSpaces.find((s) => s.name === "preview.png")!.id);
	await expect(addSpace.getByRole("status")).toHaveText("Déjà ajouté à cet espace");
	await expect(addSpace.getByRole("button", { name: "Ajouter", exact: true })).toBeDisabled();
	await addSpace.getByRole("button", { name: "Annuler", exact: true }).click();
	await page.locator(".navigation").getByRole("button", { name: "preview.png", exact: true }).click();
	const isolated = page.getByTestId("file-space-view");
	await expect(isolated.locator(".tree-row")).toHaveCount(1);
	await isolated.getByTestId("file-preview.png").click();
	await expect(isolated.locator(".file-asset-preview img")).toBeVisible();

	expect(errors).toEqual([]);
	console.log(
		"PASS: fichiers, Git, contexte, navigation, réglages, événements natifs, aucun polling, archives/restauration, FR/EN et langue persistée au rechargement. Transport Tauri mocké.",
	);
} finally {
	await browser.close();
	rmSync(directory, { recursive: true, force: true });
}
