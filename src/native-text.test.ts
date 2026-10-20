import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./i18n", () => ({ i18n: { resolvedLanguage: "fr", language: "fr" } }));

import { i18n } from "./i18n";
import { localizeNativeText } from "./native-text";

afterEach(() => {
	i18n.resolvedLanguage = "fr";
	i18n.language = "fr";
});

describe("native text localization", () => {
	it("preserves French text and labels exactly", () => {
		for (const value of [
			"Fichier binaire : aperçu texte indisponible.",
			"Lecture seule",
			"Index → fichiers locaux",
			"Commit abc1234 · premier parent",
			"Merge en cours",
			"Projet inaccessible : /projets/été\nPermission denied (os error 13)",
		]) {
			expect(localizeNativeText(value)).toBe(value);
		}
	});

	it("translates native errors, preview labels and operations in English", () => {
		i18n.resolvedLanguage = "en";
		expect(localizeNativeText("Chemin hors du projet")).toBe("Path outside the project");
		expect(localizeNativeText("Espace de fichiers invalide")).toBe("Invalid file space");
		expect(localizeNativeText("Sélectionnez un dossier")).toBe("Select a folder");
		expect(localizeNativeText("Préférences de fichiers invalides")).toBe("Invalid file preferences");
		expect(localizeNativeText("Raccourcis invalides ou identiques")).toBe("Invalid or duplicate shortcuts");
		expect(localizeNativeText("Requête de recherche invalide")).toBe("Invalid search request");
		expect(localizeNativeText("Dossier de recherche non enregistré")).toBe("Unregistered search root");

		expect(localizeNativeText("Lecture seule")).toBe("Read-only");
		expect(localizeNativeText("HEAD → index")).toBe("HEAD → index");
		expect(localizeNativeText("Index → fichiers locaux")).toBe("Index → working files");
		expect(localizeNativeText("Conflit · notre version → fichiers locaux")).toBe(
			"Conflict · our version → working files",
		);
		expect(localizeNativeText("Commit abc1234 · premier parent")).toBe("Commit abc1234 · first parent");
		expect(localizeNativeText("Branche · abc1234 → 1234abc")).toBe("Branch · abc1234 → 1234abc");
		for (const operation of ["Merge", "Rebase", "Cherry-pick", "Revert"]) {
			expect(localizeNativeText(`${operation} en cours`)).toBe(`${operation} in progress`);
		}
	});

	it("uses regional English and falls back to the requested language before resolution", () => {
		i18n.resolvedLanguage = undefined;
		i18n.language = "en-GB";
		expect(localizeNativeText("Lecture seule")).toBe("Read-only");
		i18n.resolvedLanguage = "fr";
		expect(localizeNativeText("Lecture seule")).toBe("Lecture seule");
	});

	it("translates only the anchored error wrapper and preserves every payload byte", () => {
		i18n.resolvedLanguage = "en";
		const payload =
			"/projects/été/Projet inaccessible : x\n\tfatal: invalid path 'Lecture seule' (os error 13)";
		expect(localizeNativeText(`Projet inaccessible : ${payload}`)).toBe(`Project inaccessible: ${payload}`);
		expect(localizeNativeText(`Lecture de ${payload} : Permission denied`)).toBe(
			`Reading ${payload} : Permission denied`,
		);
		expect(localizeNativeText(`Git ne démarre pas : ${payload}`)).toBe(`Git could not start: ${payload}`);
	});

	it("leaves unknown strings, paths, code and raw Git stderr untouched", () => {
		i18n.resolvedLanguage = "en";
		for (const value of [
			"fatal: path 'Lecture seule' does not exist in 'HEAD'",
			"Permission denied (os error 13)",
			"/projects/été/Index → fichiers locaux",
			'const label = "Lecture seule";',
			"Fix: Merge en cours",
			"Commit user subject · premier parent",
			"Branche · user → subject",
			"Message inconnu",
			"toString",
		]) {
			expect(localizeNativeText(value)).toBe(value);
		}
	});
});
