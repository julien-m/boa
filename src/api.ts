/** Typed IPC boundary; the packaged application has no network data service. */
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import type {
	Branch,
	Change,
	Commit,
	Comparison,
	DirectoryEntry,
	Preview,
	Project,
	Selection,
	Summary,
} from "./models";
import { localizeNativeText } from "./native-text";

export type ProjectSettings = {
	watchDirectory: string | null;
	watchError: string | null;
	language: "fr" | "en";
};

const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
	nativeInvoke<T>(command, args).catch((error: unknown) => {
		throw localizeNativeText(String(error));
	});
const settingsLabels = (value: ProjectSettings): ProjectSettings => ({
	...value,
	watchError: value.watchError ? localizeNativeText(value.watchError) : null,
});
const previewLabels = (value: Preview): Preview => ({ ...value, label: localizeNativeText(value.label) });

export const api = {
	search: (
		project: string,
		query: string,
	): Promise<{
		matches: { path: string; line: number; text: string }[];
		limited: boolean;
		warning: string | null;
	}> => invoke("search_project", { project, query }),
	projects: (): Promise<Project[]> => invoke("list_projects"),
	markdownImage: (project: string, document: string, source: string): Promise<string> =>
		invoke("read_markdown_image", { project, document, source }),
	repositoryUrl: (project: string, repo: string): Promise<string | null> =>
		invoke("repository_web_url", { project, repo }),
	openRepository: (project: string, repo: string): Promise<void> =>
		invoke("open_repository", { project, repo }),
	openProjectFolder: (project: string): Promise<void> => invoke("open_project_folder", { project }),
	settings: (): Promise<ProjectSettings> => invoke<ProjectSettings>("get_settings").then(settingsLabels),
	setLanguage: (language: "fr" | "en"): Promise<ProjectSettings> => invoke("set_language", { language }),
	setWatchDirectory: (path: string | null): Promise<ProjectSettings> =>
		invoke("set_watch_directory", { path }),
	summary: (project: string, signal?: AbortSignal): Promise<Summary> =>
		invoke<Summary>("project_summary", { project }).then((summary) => {
			// IPC work may finish after deactivation; never publish its obsolete reply.
			signal?.throwIfAborted();
			return {
				...summary,
				repos: summary.repos.map((repo) => ({
					...repo,
					operation: repo.operation ? localizeNativeText(repo.operation) : null,
					error: repo.error ? localizeNativeText(repo.error) : null,
				})),
			};
		}),
	pin: (project: string, pinned: boolean): Promise<void> => invoke("pin_project", { project, pinned }),
	add: (path: string): Promise<Project> => invoke("add_project", { path }),
	archive: (project: string, archived: boolean): Promise<void> =>
		invoke("archive_project", { project, archived }),
	directory: (project: string, path: string): Promise<DirectoryEntry[]> =>
		invoke("read_directory", { project, path }),
	saveFile: (project: string, path: string, original: string, content: string): Promise<void> =>
		invoke("save_file", { project, path, original, content }),
	preview: (selection: Selection): Promise<Preview> =>
		selection.repo
			? invoke<Preview>("git_diff", {
					request: {
						...selection,
						side: selection.side ?? "working",
						oldPath: selection.oldPath ?? null,
						hash: selection.hash ?? null,
						base: selection.base ?? null,
						head: selection.head ?? null,
					},
				}).then(previewLabels)
			: invoke<Preview>("read_file", { project: selection.project, path: selection.path }).then(
					previewLabels,
				),
	compare: (project: string, repo: string, base: string, head: string): Promise<Comparison> =>
		invoke("compare_branch", { project, repo, base, head }),
	exportContext: (prompt: string, image: string): Promise<{ markdownPath: string; imagePath: string }> =>
		invoke("export_context", { prompt, image }),
	navigate: (file: string): Promise<{ project: string; path: string }> =>
		invoke("resolve_navigation", { file }),
	history: (project: string, repo: string, offset: number, branch: string): Promise<Commit[]> =>
		invoke("git_history", { project, repo, offset, branch }),
	branches: (project: string, repo: string): Promise<Branch[]> => invoke("git_branches", { project, repo }),
	commitFiles: (project: string, repo: string, hash: string): Promise<Change[]> =>
		invoke("git_commit_files", { project, repo, hash }),
};
