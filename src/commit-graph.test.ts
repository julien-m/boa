/** Parent relationships remain distinguishable at merges and branch convergence. */
import { describe, expect, it } from "vitest";
import { commitGraph } from "./commit-graph";
import type { Commit } from "./models";

const commit = (hash: string, parents: string[]): Commit => ({
	hash,
	parents,
	subject: hash,
	date: "2026-10-15",
	author: "BOA test",
	refs: "",
});
describe("commit graph", () => {
	it("creates two parent lanes for a merge and reconnects their common parent", () => {
		const graph = commitGraph([
			commit("merge", ["left", "right"]),
			commit("left", ["base"]),
			commit("right", ["base"]),
			commit("base", []),
		]);
		expect(graph[0].edges.filter((edge) => edge.parent)).toHaveLength(2);
		expect(graph[2].edges.find((edge) => edge.parent)?.to).toBe(0);
		expect(graph[3].lanes).toBe(1);
	});
});
