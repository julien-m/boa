/**
 * Sessions table ordering: one active column and direction, remembered on this Mac.
 * Sorting only reorders rows: selection, dock tabs and filters are independent of it.
 */
import type { SessionState, SessionSummary } from "./sessions-api";

export const SORT_COLUMNS = ["title", "project", "state", "activity"] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";
export type SessionSort = { column: SortColumn; direction: SortDirection };

/** Attention order: what needs you first, then what runs, then what rests. */
export const ATTENTION: SessionState[] = [
	"awaitingInput",
	"failed",
	"working",
	"idle",
	"inactive",
	"unknown",
];

export const DEFAULT_SORT: SessionSort = { column: "activity", direction: "desc" };
const SORT_KEY = "boa-session-sort";
const GROUP_KEY = "boa-session-group";

/** Direction of a column's first click: newest activity and most urgent state come first. */
export function firstDirection(column: SortColumn): SortDirection {
	return column === "activity" ? "desc" : "asc";
}

/** First click sorts by the column; clicking the active column again reverses it. */
export function nextSort(current: SessionSort, column: SortColumn): SessionSort {
	if (current.column !== column) return { column, direction: firstDirection(column) };
	return { column, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** Most recent first; sessions without a known activity always come last. */
function byRecent(a: SessionSummary, b: SessionSummary): number {
	if (a.updatedAt === b.updatedAt) return 0;
	if (a.updatedAt === null) return 1;
	if (b.updatedAt === null) return -1;
	return b.updatedAt - a.updatedAt;
}

function byAttention(a: SessionSummary, b: SessionSummary): number {
	return ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state);
}

export function sortSessions(
	sessions: SessionSummary[],
	sort: SessionSort,
	projectName: (path: string | null) => string | null,
	locale?: string,
): SessionSummary[] {
	const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
	const sign = sort.direction === "asc" ? 1 : -1;
	const text = (a: string | null, b: string | null) => {
		// Missing names stay last whatever the direction.
		if (!a || !b) return a === b ? 0 : a ? -1 : 1;
		return sign * collator.compare(a, b);
	};
	const primary = (a: SessionSummary, b: SessionSummary): number => {
		switch (sort.column) {
			case "title":
				return text(a.title || a.key.id, b.title || b.key.id);
			case "project":
				return text(projectName(a.project), projectName(b.project));
			case "state":
				return sign * byAttention(a, b);
			case "activity": {
				const recent = byRecent(a, b);
				const unknown = a.updatedAt === null || b.updatedAt === null;
				return unknown ? recent : sign === -1 ? recent : -recent;
			}
		}
	};
	return [...sessions].sort((a, b) => {
		const order = primary(a, b);
		if (order !== 0) return order;
		// Ties: activity sorts by attention, every other column by most recent activity.
		return sort.column === "activity" ? byAttention(a, b) : byRecent(a, b);
	});
}

function isColumn(value: unknown): value is SortColumn {
	return SORT_COLUMNS.includes(value as SortColumn);
}

/** Valid stored sort, migrating the former select values; anything else is the default. */
export function parseSort(raw: string | null): SessionSort {
	if (raw === "state") return { column: "state", direction: "asc" };
	if (raw === "activity") return DEFAULT_SORT;
	if (raw === "project") return { column: "project", direction: "asc" };
	try {
		const value = JSON.parse(raw ?? "null") as Partial<SessionSort> | null;
		if (value && isColumn(value.column) && (value.direction === "asc" || value.direction === "desc"))
			return { column: value.column, direction: value.direction };
	} catch {
		// Corrupted value: fall back to the default order.
	}
	return DEFAULT_SORT;
}

function storage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

export function readSort(): SessionSort {
	return parseSort(storage()?.getItem(SORT_KEY) ?? null);
}

export function writeSort(sort: SessionSort): void {
	try {
		storage()?.setItem(SORT_KEY, JSON.stringify(sort));
	} catch {
		// Storage blocked or full: the order still applies for this window.
	}
}

/** Project grouping is an option; the former « Project » sort meant grouping, so it keeps it. */
export function readGrouping(): boolean {
	const store = storage();
	const value = store?.getItem(GROUP_KEY) ?? null;
	return value === null ? store?.getItem(SORT_KEY) === "project" : value === "1";
}

export function writeGrouping(grouped: boolean): void {
	try {
		storage()?.setItem(GROUP_KEY, grouped ? "1" : "0");
	} catch {
		// Storage blocked or full: grouping still applies for this window.
	}
}
