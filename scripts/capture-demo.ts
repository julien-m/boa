/** README captures: real frontend, fictional in-memory IPC; never reads personal projects. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";

const output = resolve("docs/images");
mkdirSync(output, { recursive: true });
const names = ["Cedar", "Atlas", "Nimbus", "Orbit", "Quartz", "Studio"];
const projects = names.map((name, index) => ({
	name,
	path: `/Users/example/Projects/${name.toLowerCase()}`,
	pinned: index < 3,
	archived: false,
}));
const files = [
	"src/lib/pricing.ts",
	"src/components/plan-card.tsx",
	"src/styles/theme.css",
	"README.md",
	"package.json",
	"tests/pricing.test.ts",
];
const changes = files.map((path, index) => ({
	path,
	oldPath: null,
	index: ".",
	worktree: index === 5 ? "?" : "M",
	conflict: false,
}));
const before = `export interface Plan {
  name: string;
  monthlyPrice: number;
  seats: number;
}

export const plans: Plan[] = [
  { name: "Starter", monthlyPrice: 12, seats: 1 },
  { name: "Team", monthlyPrice: 29, seats: 5 },
  { name: "Studio", monthlyPrice: 79, seats: 20 },
];

export function annualPrice(plan: Plan): number {
  return plan.monthlyPrice * 12;
}

export function formatPrice(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
`;
const after = before.replace(
	"export function annualPrice(plan: Plan): number {\n  return plan.monthlyPrice * 12;",
	`const ANNUAL_DISCOUNT = 0.2;

export function annualPrice(plan: Plan): number {
  const total = plan.monthlyPrice * 12;
  return Math.round(total * (1 - ANNUAL_DISCOUNT));`,
);
const hashes = Array.from({ length: 8 }, (_, index) => (index + 1).toString(16).repeat(40));
const subjects = [
	"feat: add annual billing discount",
	"Merge branch 'feature/pricing'",
	"feat: introduce pricing plans",
	"fix: align plan card spacing",
	"docs: update getting started guide",
	"refactor: extract shared theme tokens",
	"test: cover billing calculations",
	"chore: initialize Cedar workspace",
];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(8_000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.exposeFunction("boaDemoInvoke", async (command: string, args: Record<string, unknown> = {}) => {
	if (command.startsWith("plugin:event|")) return 1;
	if (command === "plugin:deep-link|get_current") return null;
	switch (command) {
		case "get_settings":
			return { watchDirectory: null, watchError: null, language: "en" };
		case "list_projects":
			return projects;
		case "project_summary": {
			const index = projects.findIndex((project) => project.path === args.project);
			if (index < 0) throw new Error("Unknown fictional project");
			return {
				repos: [
					{
						path: args.project,
						name: names[index],
						branch: index === 0 ? "feature/annual-billing" : "main",
						upstream: "origin/main",
						ahead: [2, 0, 1, 0, 0, 0][index],
						behind: index === 3 ? 1 : 0,
						changes: changes.slice(0, [6, 0, 3, 0, 2, 0][index]),
						operation: null,
						error: null,
					},
				],
				scanLimited: false,
				updatedAt: Date.parse("2026-10-16T10:30:00Z"),
			};
		}
		case "repository_web_url":
			return "https://github.com/example/cedar";
		case "read_directory": {
			const path = String(args.path);
			const entries: Record<string, string[]> = {
				"": [
					"src/",
					"tests/",
					"public/",
					".gitignore",
					"README.md",
					"package.json",
					"tsconfig.json",
					"vite.config.ts",
				],
				src: ["components/", "lib/", "styles/", "app.tsx", "main.tsx"],
				"src/lib": ["pricing.ts", "format.ts"],
				"src/components": ["plan-card.tsx", "navigation.tsx"],
				"src/styles": ["theme.css"],
				tests: ["pricing.test.ts"],
			};
			return (entries[path] ?? []).map((entry) => ({
				name: entry.replace(/\/$/, ""),
				path: [path, entry.replace(/\/$/, "")].filter(Boolean).join("/"),
				directory: entry.endsWith("/"),
				symlink: false,
				repository: false,
			}));
		}
		case "read_file":
			return { original: "", modified: after, path: args.path, label: "Read-only" };
		case "git_diff":
			return {
				original: before,
				modified: after,
				path: (args.request as { path: string }).path,
				label: (args.request as { hash?: string }).hash ? "Commit 1111111" : "Index → local files",
			};
		case "git_branches":
			return [
				{ name: "main", current: false, remote: false },
				{ name: "feature/annual-billing", current: true, remote: false },
				{ name: "origin/main", current: false, remote: true },
			];
		case "git_history":
			return hashes.map((hash, index) => ({
				hash,
				parents: index === 1 ? [hashes[3], hashes[2]] : hashes[index + 1] ? [hashes[index + 1]] : [],
				author: index % 2 ? "Alex Morgan" : "Sam Rivera",
				date: `2026-10-${16 - Math.floor(index / 2)}T10:30:00Z`,
				subject: subjects[index],
				refs: index === 0 ? "HEAD -> feature/annual-billing" : index === 3 ? "main, origin/main" : "",
			}));
		case "git_commit_files":
			return changes.slice(0, 3);
		default:
			throw new Error(`Unexpected demo IPC: ${command}`);
	}
});
await page.addInitScript(() => {
	localStorage.clear();
	localStorage.setItem("boa-language", "en");
	Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
	Object.defineProperty(window, "__TAURI_INTERNALS__", {
		value: {
			invoke: (command: string, args: Record<string, unknown>) =>
				Reflect.get(window, "boaDemoInvoke")(command, args),
			transformCallback: () => 1,
			unregisterCallback: () => {},
		},
	});
});
try {
	await page.goto(process.env.BOA_DEMO_URL ?? "http://localhost:1420");
	await expect(page.getByTestId("project-card-Cedar")).toBeVisible();
	await expect(page.getByTestId("dashboard-counts")).toContainText("11");
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: resolve(output, "dashboard.png") });
	await page.getByTestId("open-project-Cedar").click();
	await page.getByTestId("file-src").click();
	await page.getByTestId("file-src/lib").click();
	await page.getByTestId("file-src/lib/pricing.ts").click();
	await page.getByTestId("git-history-tab").click();
	await page.getByTestId("change-src/lib/pricing.ts").click();
	await expect(page.locator(".monaco-diff-editor")).toBeVisible();
	await expect(page.getByTestId(`commit-${hashes[0]}`)).toBeVisible();
	// Monaco lays out and tokenizes asynchronously after becoming visible.
	await expect(
		page.locator(".monaco-diff-editor .view-line").filter({ hasText: "ANNUAL_DISCOUNT" }).first(),
	).toBeVisible();
	await page.mouse.move(1595, 1045);
	await page.screenshot({ path: resolve(output, "project.png") });
	expect(errors).toEqual([]);
	console.log("Captured dashboard.png and project.png from BOA with fictional projects only.");
} finally {
	await browser.close();
}
