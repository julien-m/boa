/** Bundled offline translations; the native preference is authoritative. */
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { dashboardEn, dashboardFr } from "./locales/dashboard";
import { gitEn, gitFr } from "./locales/git";
import { settingsEn, settingsFr } from "./locales/settings";
import { workspaceEn, workspaceFr } from "./locales/workspace";

export const i18n = i18next.createInstance();
const cached = typeof localStorage === "undefined" ? null : localStorage.getItem("boa-language");
void i18n.use(initReactI18next).init({
	resources: {
		fr: { dashboard: dashboardFr, workspace: workspaceFr, git: gitFr, settings: settingsFr },
		en: { dashboard: dashboardEn, workspace: workspaceEn, git: gitEn, settings: settingsEn },
	},
	lng: cached === "en" ? "en" : "fr",
	fallbackLng: "fr",
	supportedLngs: ["fr", "en"],
	defaultNS: "dashboard",
	interpolation: { escapeValue: false },
	initAsync: false,
});
export const getLocale = (): string => (i18n.language.startsWith("en") ? "en-US" : "fr-FR");
export async function setInterfaceLanguage(language: string): Promise<void> {
	const supported = language === "en" ? "en" : "fr";
	await i18n.changeLanguage(supported);
	if (typeof document !== "undefined") {
		document.documentElement.lang = supported;
		document.title = supported === "en" ? "BOA — Projects & Git" : "BOA — Projets & Git";
	}
	if (typeof localStorage !== "undefined") localStorage.setItem("boa-language", supported);
}
