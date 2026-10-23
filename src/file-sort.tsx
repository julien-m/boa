import { useFileLabels } from "./file-workspace-labels";

export const fileSorts = [
	"name",
	"name-desc",
	"added",
	"added-asc",
	"modified",
	"modified-asc",
	"created",
	"created-asc",
	"type",
	"type-desc",
	"size",
	"size-asc",
] as const;

type SortableFile = {
	name: string;
	path: string;
	directory?: boolean;
	modified?: number | null;
	added?: number | null;
	created?: number | null;
	size?: number | null;
};

export function sortFiles<T extends SortableFile>(entries: T[], sort: string): T[] {
	const type = (entry: T) => {
		const dot = entry.name.lastIndexOf(".");
		return dot > 0 ? entry.name.slice(dot + 1).toLocaleLowerCase() : "";
	};
	const tie = (a: T, b: T) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
	return [...entries].sort((a, b) => {
		if (["added", "modified", "created", "size"].some((key) => sort === key || sort === `${key}-asc`)) {
			const key = sort.split("-")[0] as "added" | "modified" | "created" | "size";
			if (key === "size" && !!a.directory !== !!b.directory) return a.directory ? -1 : 1;
			const valid = (value: number | null | undefined) =>
				value != null && (key === "size" ? value >= 0 : value > 0) ? value : null;
			const av = valid(a[key]),
				bv = valid(b[key]);
			if (av == null || bv == null) return av == null && bv == null ? tie(a, b) : av == null ? 1 : -1;
			return (av - bv) * (sort.endsWith("-asc") ? 1 : -1) || tie(a, b);
		}
		const folders = Number(!!b.directory) - Number(!!a.directory);
		if (folders) return folders;
		if (sort === "type" || sort === "type-desc") {
			return type(a).localeCompare(type(b)) * (sort === "type-desc" ? -1 : 1) || tie(a, b);
		}
		return tie(a, b) * (sort === "name-desc" ? -1 : 1);
	});
}

export function FileSortOptions() {
	const l = useFileLabels();
	const labels = [
		l.nameSort,
		l.nameDescendingSort,
		l.addedSort,
		l.addedAscendingSort,
		l.modifiedSort,
		l.modifiedAscendingSort,
		l.createdSort,
		l.createdAscendingSort,
		l.typeSort,
		l.typeDescendingSort,
		l.sizeSort,
		l.sizeAscendingSort,
	];
	return fileSorts.map((value, i) => (
		<option key={value} value={value}>
			{labels[i]}
		</option>
	));
}
