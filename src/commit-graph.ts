/** Projects the actual parent graph into stable lanes, without inventing edges. */
import type { Commit } from "./models";
export interface GraphRow {
	lane: number;
	lanes: number;
	edges: { from: number; to: number; parent: boolean }[];
}

export function commitGraph(commits: Commit[]): GraphRow[] {
	let active: string[] = [];
	return commits.map((commit) => {
		if (!active.includes(commit.hash)) active.push(commit.hash);
		const before = [...active];
		const lane = before.indexOf(commit.hash);
		const after = active.filter((hash) => hash !== commit.hash);
		// Keep existing lanes and insert unseen parents next to their child.
		for (const [index, parent] of commit.parents.entries())
			if (!after.includes(parent)) after.splice(Math.min(lane + index, after.length), 0, parent);
		const edges = before.flatMap((hash, from) =>
			hash === commit.hash
				? commit.parents.map((parent) => ({ from, to: after.indexOf(parent), parent: true }))
				: [{ from, to: after.indexOf(hash), parent: false }],
		);
		active = after;
		return { lane, lanes: Math.max(before.length, after.length), edges };
	});
}
