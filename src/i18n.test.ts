import { afterEach, describe, expect, it } from "vitest";
import { getLocale, i18n, setInterfaceLanguage } from "./i18n";
import { dashboardEn, dashboardFr } from "./locales/dashboard";
import { gitEn, gitFr } from "./locales/git";
import { settingsEn, settingsFr } from "./locales/settings";
import { workspaceEn, workspaceFr } from "./locales/workspace";

function entries(value: Record<string, unknown>, prefix = ""): [string, string][] {
	return Object.entries(value).flatMap(([key, item]) =>
		typeof item === "string"
			? [[`${prefix}${key}`, item] as [string, string]]
			: entries(item as Record<string, unknown>, `${prefix}${key}.`),
	);
}

afterEach(async () => {
	await setInterfaceLanguage("fr");
});

describe("bundled interface languages", () => {
	it("provides matching French and English keys and interpolation parameters", () => {
		for (const [fr, en] of [
			[dashboardFr, dashboardEn],
			[workspaceFr, workspaceEn],
			[gitFr, gitEn],
			[settingsFr, settingsEn],
		]) {
			const french = entries(fr);
			const english = new Map(entries(en));
			expect([...english.keys()].sort()).toEqual(french.map(([key]) => key).sort());
			for (const [key, value] of french) {
				expect(english.get(key)?.trim(), key).toBeTruthy();
				expect(
					english
						.get(key)
						?.match(/\{\{[^}]+\}\}/g)
						?.sort() ?? [],
					key,
				).toEqual(value.match(/\{\{[^}]+\}\}/g)?.sort() ?? []);
			}
		}
	});
	it("switches real catalogues and locale with plural-aware counts", async () => {
		await setInterfaceLanguage("en");
		expect(getLocale()).toBe("en-US");
		expect(i18n.t("settings:title")).toBe("Settings");
		expect(i18n.t("git:commitCount", { count: 1 })).toBe("1 commit");
		expect(i18n.t("git:commitCount", { count: 2 })).toBe("2 commits");
		await setInterfaceLanguage("fr");
		expect(getLocale()).toBe("fr-FR");
		expect(i18n.t("settings:title")).toBe("Réglages");
		await setInterfaceLanguage("unsupported");
		expect(i18n.language).toBe("fr");
	});
});
