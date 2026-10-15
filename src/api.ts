/** Typed IPC boundary; the packaged application has no network data service. */
import { invoke } from "@tauri-apps/api/core";
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
	summary: (project: string): Promise<Summary> => invoke("project_summary", { project }),
	pin: (project: string, pinned: boolean): Promise<void> => invoke("pin_project", { project, pinned }),
	add: (path: string): Promise<Project> => invoke("add_project", { path }),
	directory: (project: string, path: string): Promise<DirectoryEntry[]> =>
		invoke("read_directory", { project, path }),
	preview: (selection: Selection): Promise<Preview> =>
		selection.repo
			? invoke("git_diff", {
					request: {
						...selection,
						side: selection.side ?? "working",
						oldPath: selection.oldPath ?? null,
						hash: selection.hash ?? null,
						base: selection.base ?? null,
						head: selection.head ?? null,
					},
				})
			: invoke("read_file", { project: selection.project, path: selection.path }),
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
