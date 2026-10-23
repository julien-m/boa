/** Native DTOs shared by the project, file and Git views. */
export interface Project {
	path: string;
	name: string;
	pinned: boolean;
	archived: boolean;
}
export interface Change {
	path: string;
	oldPath: string | null;
	index: string;
	worktree: string;
	conflict: boolean;
}
export interface RepoStatus {
	path: string;
	name: string;
	branch: string;
	upstream: string | null;
	ahead: number | null;
	behind: number | null;
	changes: Change[];
	operation: string | null;
	error: string | null;
}
export interface Summary {
	repos: RepoStatus[];
	scanLimited: boolean;
	updatedAt: number | null;
}
export interface DirectoryEntry {
	name: string;
	path: string;
	directory: boolean;
	symlink: boolean;
	repository: boolean;
	modified?: number;
}
export interface Preview {
	kind?: "text" | "image" | "unsupported";
	dataUrl?: string;
	reason?: string;
	original: string;
	modified: string;
	path: string;
	label: string;
}
export interface Commit {
	hash: string;
	parents: string[];
	author: string;
	date: string;
	subject: string;
	refs: string;
}
export interface Branch {
	name: string;
	current: boolean;
	remote: boolean;
}
export interface Selection {
	project: string;
	absolutePath?: string;
	repo?: string;
	path: string;
	oldPath?: string | null;
	side?: "working" | "staged";
	hash?: string;
	base?: string;
	head?: string;
	line?: number;
	endLine?: number;
	navigationId?: string;
	anchor?: string;
}
export interface Comparison {
	base: string;
	head: string;
	mergeBase: string;
	changes: Change[];
}
export type Layout = "split" | "files" | "git";
export interface Counts {
	files: number;
	ahead: number;
	behind: number;
	unknown: number;
	errors: number;
}

/** Deduplicates physical checkouts before aggregating a dashboard. */
export function countRepos(repos: RepoStatus[]): Counts {
	const unique = new Map(repos.map((repo) => [repo.path, repo]));
	return [...unique.values()].reduce<Counts>(
		(counts, repo) => ({
			files: counts.files + repo.changes.length,
			ahead: counts.ahead + (repo.ahead ?? 0),
			behind: counts.behind + (repo.behind ?? 0),
			unknown: counts.unknown + (repo.upstream ? 0 : 1),
			errors: counts.errors + (repo.error ? 1 : 0),
		}),
		{ files: 0, ahead: 0, behind: 0, unknown: 0, errors: 0 },
	);
}
