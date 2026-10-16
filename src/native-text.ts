import { i18n } from "./i18n";

// Only call this for native UI labels and error messages, never repository content.
const englishText: Record<string, string> = {
	"Lien BOA inconnu": "Unknown BOA link",
	"Chemin ou lignes invalides dans le lien BOA": "Invalid path or lines in the BOA link",
	"Langue non prise en charge": "Unsupported language",
	"Bulle trop volumineuse pour l’export": "Context bubble too large to export",
	"Capture PNG requise": "PNG capture required",
	"Capture PNG invalide": "Invalid PNG capture",
	"Chemin hors du projet": "Path outside the project",
	"Ce chemin ne désigne pas un fichier régulier": "This path does not point to a regular file",
	"Fichier trop volumineux pour l’aperçu (2 Mo maximum).": "File too large to preview (2 MB maximum).",
	"Fichier binaire : aperçu texte indisponible.": "Binary file: text preview unavailable.",
	"Ce fichier n’est pas encodé en UTF-8.": "This file is not encoded in UTF-8.",
	"Nom de fichier non UTF-8": "Non-UTF-8 filename",
	"Dossier contenant plus de 3 000 éléments : ouvrez un sous-dossier.":
		"Folder contains over 3,000 items: open a subfolder.",
	"Entrée Git invalide": "Invalid Git entry",
	"Sous-module : sélectionnez son dépôt pour voir les fichiers.":
		"Submodule: select its repository to view the files.",
	"Entrée d’index Git invalide": "Invalid Git index entry",
	"Chemin de lien invalide": "Invalid symlink path",
	"Lien situé hors du dépôt": "Symlink outside the repository",
	"Cible de lien non UTF-8": "Non-UTF-8 symlink target",
	"Type de diff inconnu": "Unknown diff type",
	"Sélectionnez un dossier": "Select a folder",
	"Chemin non UTF-8": "Non-UTF-8 path",
	"Projet non enregistré dans BOA": "Project not registered in BOA",
	"Dépôt non rattaché à ce projet": "Repository not attached to this project",
	"Saisissez une recherche de 1 à 1 000 caractères.": "Enter a search of 1 to 1,000 characters.",
	"Installez ripgrep pour rechercher dans les projets (brew install ripgrep).":
		"Install ripgrep to search projects (brew install ripgrep).",
	"Sortie recherche indisponible": "Search output unavailable",
	"Erreurs recherche indisponibles": "Search error output unavailable",
	"Recherche interrompue après 10 secondes ; précisez votre requête.":
		"Search stopped after 10 seconds; refine your query.",
	"Recherche interrompue": "Search interrupted",
	"Chemin Git invalide": "Invalid Git path",
	"Chemin de navigation invalide": "Invalid navigation path",
	"Le chemin doit désigner un fichier": "The path must point to a file",
	"Importez d’abord ce projet dans BOA": "Import this project into BOA first",
	"Dossier RPC manquant": "RPC folder missing",
	"Dossier RPC non privé ou propriétaire incorrect": "RPC folder is not private or has the wrong owner",
	"Chemin RPC non sûr": "Unsafe RPC path",
	"Une instance RPC BOA est déjà active": "A BOA RPC instance is already running",
	"Requête RPC trop grande": "RPC request too large",
	"Requête RPC incomplète": "Incomplete RPC request",
	"Sortie Git indisponible": "Git output unavailable",
	"Erreurs Git indisponibles": "Git error output unavailable",
	"Git a dépassé 20 secondes ; réessayez sur un dépôt moins volumineux.":
		"Git exceeded 20 seconds; try again with a smaller repository.",
	"Lecture Git interrompue": "Git read interrupted",
	"Résultat trop volumineux (12 Mo maximum).": "Result too large (12 MB maximum).",
	"Git renvoie des noms de fichiers non UTF-8.": "Git returned non-UTF-8 filenames.",
	"Révision Git invalide": "Invalid Git revision",
	"Hash de commit invalide": "Invalid commit hash",
	"Liste Git incomplète": "Incomplete Git list",
	"Renommage Git incomplet": "Incomplete Git rename",
	"Comparaison Git incomplète": "Incomplete Git comparison",
	"Renommage incomplet": "Incomplete rename",
	"Lecture seule": "Read-only",
	"HEAD → index": "HEAD → index",
	"Index → fichiers locaux": "Index → working files",
	"Conflit · notre version → fichiers locaux": "Conflict · our version → working files",
	"Merge en cours": "Merge in progress",
	"Rebase en cours": "Rebase in progress",
	"Cherry-pick en cours": "Cherry-pick in progress",
	"Revert en cours": "Revert in progress",
};

// Replace only the known wrapper. Everything after it is opaque OS/Git/path data.
const englishPrefixes: [string, string][] = [
	["Surveillance indisponible : ", "File monitoring unavailable: "],
	["Configuration BOA illisible : ", "Cannot read BOA configuration: "],
	["Projet inaccessible : ", "Project inaccessible: "],
	["Dossier surveillé inaccessible : ", "Watched folder inaccessible: "],
	["Lecture du dossier surveillé : ", "Reading watched folder: "],
	["Requête RPC invalide : ", "Invalid RPC request: "],
	["Lecture RPC : ", "RPC read: "],
	["Git ne démarre pas : ", "Git could not start: "],
	["BOA n’a pas pu démarrer : ", "BOA could not start: "],
	["Lecture de ", "Reading "],
];

export function localizeNativeText(value: string): string {
	if (!(i18n.resolvedLanguage || i18n.language || "fr").startsWith("en")) return value;
	if (Object.hasOwn(englishText, value)) return englishText[value];
	const commit = /^Commit ([a-fA-F0-9]{7}) · premier parent$/.exec(value);
	if (commit) return `Commit ${commit[1]} · first parent`;
	const branch = /^Branche · ([a-fA-F0-9]{7}) → ([a-fA-F0-9]{7})$/.exec(value);
	if (branch) return `Branch · ${branch[1]} → ${branch[2]}`;
	for (const [source, target] of englishPrefixes) {
		if (value.startsWith(source)) return target + value.slice(source.length);
	}
	return value;
}
